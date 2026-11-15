import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { PublishError } from '@/engine/publish/changes';
import type { GithubAppConfig } from '../config';
import { decryptSecret, encryptSecret } from './crypto';
import {
  exchangeCode,
  listInstallations,
  OAuthError,
  refreshTokens,
  revokeGrant,
  type OAuthTokens,
} from './oauth';

const REFRESH_SKEW_MS = 120_000;

const GhUser = z.object({ id: z.number(), login: z.string(), avatar_url: z.string().url().optional() });

async function fetchUser(accessToken: string, f: typeof fetch) {
  const res = await f('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'RepoRevive',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new OAuthError(
      res.status === 401 ? 'REVOKED' : 'PROVIDER',
      `GitHub responded ${res.status} for /user.`,
    );
  const p = GhUser.safeParse(await res.json());
  if (!p.success) throw new OAuthError('PROVIDER', 'Unexpected /user response.');
  return p.data;
}

async function storeTokens(db: PrismaClient, cfg: GithubAppConfig, userId: string, t: OAuthTokens) {
  const data = {
    status: 'ACTIVE' as const,
    accessTokenEnc: encryptSecret(t.accessToken, cfg.encryptionKey, userId),
    accessTokenExpiresAt: t.accessExpiresAt,
    refreshTokenEnc: t.refreshToken ? encryptSecret(t.refreshToken, cfg.encryptionKey, userId) : null,
    refreshTokenExpiresAt: t.refreshExpiresAt,
    lastValidatedAt: new Date(),
    revokedAt: null,
  };
  await db.githubConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

export async function syncInstallations(
  db: PrismaClient,
  cfg: GithubAppConfig,
  userId: string,
  accessToken: string,
  f: typeof fetch = fetch,
) {
  const list = await listInstallations(accessToken, f);
  const ids = list.map((i) => i.id);
  await db.githubInstallation.deleteMany({ where: { userId, installationId: { notIn: ids } } });
  for (const i of list) {
    const data = {
      userId,
      accountLogin: i.account!.login,
      accountType: i.account!.type ?? 'User',
      repositorySelection: i.repository_selection,
      permissions: i.permissions ?? {},
    };
    await db.githubInstallation.upsert({
      where: { installationId: i.id },
      create: { installationId: i.id, ...data },
      update: data,
    });
  }
  return list.length;
}

/** Finish the OAuth flow: exchange the code, identify the account, store encrypted credentials. */
export async function completeLogin(
  db: PrismaClient,
  cfg: GithubAppConfig,
  code: string,
  f: typeof fetch = fetch,
) {
  const tokens = await exchangeCode(cfg, code, f);
  const gh = await fetchUser(tokens.accessToken, f);
  const user = await db.user.upsert({
    where: { githubUserId: gh.id },
    create: { githubUserId: gh.id, login: gh.login, avatarUrl: gh.avatar_url ?? null },
    update: { login: gh.login, avatarUrl: gh.avatar_url ?? null },
  });
  await storeTokens(db, cfg, user.id, tokens);
  await syncInstallations(db, cfg, user.id, tokens.accessToken, f).catch(() => 0);
  return user;
}

/**
 * Returns a usable access token, refreshing it when close to expiry. Marks the connection
 * EXPIRED/REVOKED and throws AUTH_EXPIRED when GitHub no longer honours it. The token never leaves this process.
 */
export async function getAccessToken(
  db: PrismaClient,
  cfg: GithubAppConfig,
  userId: string,
  f: typeof fetch = fetch,
): Promise<string> {
  const conn = await db.githubConnection.findUnique({ where: { userId } });
  if (!conn || conn.status !== 'ACTIVE')
    throw new PublishError('AUTH_EXPIRED', 'GitHub is not connected. Reconnect your account.');
  const access = decryptSecret(conn.accessTokenEnc, cfg.encryptionKey, userId);
  const expiring =
    conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_SKEW_MS;
  if (!expiring) return access;
  if (
    !conn.refreshTokenEnc ||
    (conn.refreshTokenExpiresAt && conn.refreshTokenExpiresAt.getTime() < Date.now())
  ) {
    await db.githubConnection.update({ where: { userId }, data: { status: 'EXPIRED' } });
    throw new PublishError('AUTH_EXPIRED', 'The GitHub authorization expired. Reconnect your account.');
  }
  try {
    const t = await refreshTokens(cfg, decryptSecret(conn.refreshTokenEnc, cfg.encryptionKey, userId), f);
    // Refresh tokens are single use: only the writer whose snapshot is still current may store the rotation.
    const next = {
      accessTokenEnc: encryptSecret(t.accessToken, cfg.encryptionKey, userId),
      accessTokenExpiresAt: t.accessExpiresAt,
      refreshTokenEnc: t.refreshToken ? encryptSecret(t.refreshToken, cfg.encryptionKey, userId) : null,
      refreshTokenExpiresAt: t.refreshExpiresAt,
      lastValidatedAt: new Date(),
    };
    const res = await db.githubConnection.updateMany({
      where: { userId, refreshTokenEnc: conn.refreshTokenEnc },
      data: next,
    });
    if (res.count === 0) {
      const again = await db.githubConnection.findUnique({ where: { userId } });
      if (!again || again.status !== 'ACTIVE')
        throw new PublishError('AUTH_EXPIRED', 'Reconnect your GitHub account.');
      return decryptSecret(again.accessTokenEnc, cfg.encryptionKey, userId);
    }
    return t.accessToken;
  } catch (err) {
    if (err instanceof PublishError) throw err;
    if (err instanceof OAuthError && err.code === 'NETWORK')
      throw new PublishError('NETWORK', err.message, true);
    await db.githubConnection.update({
      where: { userId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    throw new PublishError(
      'AUTH_EXPIRED',
      'GitHub rejected the stored authorization. Reconnect your account.',
    );
  }
}

/** Revoke at GitHub (best effort) and delete every stored credential for this user. */
export async function disconnect(
  db: PrismaClient,
  cfg: GithubAppConfig,
  userId: string,
  f: typeof fetch = fetch,
) {
  const conn = await db.githubConnection.findUnique({ where: { userId } });
  let revoked = false;
  if (conn) {
    try {
      revoked = await revokeGrant(cfg, decryptSecret(conn.accessTokenEnc, cfg.encryptionKey, userId), f);
    } catch {
      revoked = false;
    }
  }
  await db.$transaction([
    db.githubConnection.deleteMany({ where: { userId } }),
    db.githubInstallation.deleteMany({ where: { userId } }),
    db.repositoryPermission.deleteMany({ where: { userId } }),
  ]);
  return { revoked };
}
