import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { GithubAppConfig } from '../config';
import { safeEqual, signValue, verifyValue } from './crypto';

export const STATE_COOKIE = 'rr_oauth';
export const RETURN_COOKIE = 'rr_return';
export const SESSION_COOKIE = 'rr_session';
const STATE_TTL_SEC = 600;
const SESSION_TTL_SEC = 30 * 24 * 3600;

export function newState(cfg: Pick<GithubAppConfig, 'sessionSecret'>, now = Date.now()) {
  const state = randomBytes(32).toString('hex');
  return { state, cookie: signValue(cfg.sessionSecret, 'oauth-state', state, STATE_TTL_SEC, now) };
}

/** Constant-time check that the callback `state` equals the one bound to this browser. Single use is enforced by clearing the cookie. */
export function checkState(
  cfg: Pick<GithubAppConfig, 'sessionSecret'>,
  cookie: string | undefined,
  queryState: string | null,
  now = Date.now(),
): boolean {
  const bound = verifyValue(cfg.sessionSecret, 'oauth-state', cookie, now);
  return !!bound && !!queryState && safeEqual(bound, queryState);
}

/** Only same-site relative paths may be used as a post-login redirect (no open redirect). */
export function safeReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\r\n]/.test(value)
  )
    return '/';
  return value.slice(0, 200);
}

export function sessionCookieValue(
  cfg: Pick<GithubAppConfig, 'sessionSecret'>,
  userId: string,
  now = Date.now(),
) {
  return signValue(cfg.sessionSecret, 'session', userId, SESSION_TTL_SEC, now);
}
export function sessionUserId(
  cfg: Pick<GithubAppConfig, 'sessionSecret'>,
  cookie: string | undefined,
  now = Date.now(),
) {
  return verifyValue(cfg.sessionSecret, 'session', cookie, now);
}
export const SESSION_MAX_AGE = SESSION_TTL_SEC;
export const STATE_MAX_AGE = STATE_TTL_SEC;

export function authorizeUrl(cfg: GithubAppConfig, state: string): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', `${cfg.baseUrl}/api/github/callback`);
  u.searchParams.set('state', state);
  return u.toString();
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
});
export interface OAuthTokens {
  accessToken: string;
  accessExpiresAt: Date | null;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
}

export class OAuthError extends Error {
  constructor(
    readonly code: 'BAD_CODE' | 'REVOKED' | 'NETWORK' | 'PROVIDER',
    message: string,
  ) {
    super(message);
  }
}

function parseTokens(json: unknown, now: number): OAuthTokens {
  const err = z.object({ error: z.string(), error_description: z.string().optional() }).safeParse(json);
  if (err.success)
    throw new OAuthError(
      err.data.error === 'bad_refresh_token' || err.data.error === 'bad_verification_code'
        ? 'BAD_CODE'
        : 'PROVIDER',
      err.data.error_description ?? err.data.error,
    );
  const p = TokenResponse.safeParse(json);
  if (!p.success) throw new OAuthError('PROVIDER', 'Unexpected token response from GitHub.');
  return {
    accessToken: p.data.access_token,
    accessExpiresAt: p.data.expires_in ? new Date(now + p.data.expires_in * 1000) : null,
    refreshToken: p.data.refresh_token ?? null,
    refreshExpiresAt: p.data.refresh_token_expires_in
      ? new Date(now + p.data.refresh_token_expires_in * 1000)
      : null,
  };
}

async function tokenRequest(
  body: Record<string, string>,
  f: typeof fetch,
  now: number,
): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await f('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'RepoRevive' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new OAuthError('NETWORK', 'Could not reach GitHub.');
  }
  return parseTokens(await res.json().catch(() => null), now);
}

export const exchangeCode = (cfg: GithubAppConfig, code: string, f: typeof fetch = fetch, now = Date.now()) =>
  tokenRequest(
    {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: `${cfg.baseUrl}/api/github/callback`,
    },
    f,
    now,
  );

export const refreshTokens = (
  cfg: GithubAppConfig,
  refreshToken: string,
  f: typeof fetch = fetch,
  now = Date.now(),
) =>
  tokenRequest(
    {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    f,
    now,
  );

/** Revoke the user's authorization of the app (removes the grant and all its tokens). Best effort; returns whether GitHub confirmed. */
export async function revokeGrant(
  cfg: GithubAppConfig,
  accessToken: string,
  f: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await f(`https://api.github.com/applications/${encodeURIComponent(cfg.clientId)}/grant`, {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
        'content-type': 'application/json',
        'user-agent': 'RepoRevive',
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}

const Installations = z.object({
  installations: z.array(
    z.object({
      id: z.number(),
      account: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
      repository_selection: z.string(),
      permissions: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

export async function listInstallations(accessToken: string, f: typeof fetch = fetch) {
  const res = await f('https://api.github.com/user/installations?per_page=100', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'RepoRevive',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new OAuthError('REVOKED', 'GitHub rejected the stored credentials.');
  if (!res.ok) throw new OAuthError('PROVIDER', `GitHub responded ${res.status}.`);
  const p = Installations.safeParse(await res.json());
  return p.success ? p.data.installations.filter((i) => i.account) : [];
}
