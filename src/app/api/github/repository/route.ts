import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { PublishError } from '@/engine/publish/changes';
import { GitHubRest } from '@/engine/publish/github-rest';
import { jsonError } from '@/server/api';
import { currentUser } from '@/server/auth';
import { config } from '@/server/config';
import { prisma } from '@/server/db';
import { getAccessToken } from '@/server/github/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Q = z.object({
  owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
});

/**
 * Which publishing path would apply to this repository for the signed-in user:
 * direct branch (push access), fork (read access only), or none.
 */
export async function GET(req: NextRequest) {
  const gh = config().github;
  if (!gh)
    return jsonError(503, 'GITHUB_NOT_CONFIGURED', 'GitHub integration is not configured on this server.');
  const user = await currentUser(req);
  if (!user) return jsonError(401, 'UNAUTHENTICATED', 'Sign in with GitHub first.');
  const q = Q.safeParse({
    owner: req.nextUrl.searchParams.get('owner'),
    name: req.nextUrl.searchParams.get('name'),
  });
  if (!q.success) return jsonError(400, 'INVALID_REPO', 'Invalid repository.');
  try {
    const token = await getAccessToken(prisma, gh, user.id);
    const repo = await new GitHubRest({ getToken: () => token }).getRepo(q.data.owner, q.data.name);
    if (!repo)
      return NextResponse.json({
        accessible: false,
        path: 'none',
        reason:
          'Not accessible with your GitHub authorization. Install the RepoRevive GitHub App on this repository or your account.',
      });
    await prisma.repositoryPermission.upsert({
      where: { userId_owner_name: { userId: user.id, owner: repo.owner, name: repo.name } },
      create: {
        userId: user.id,
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        canPush: repo.permissions.push,
        canFork: repo.permissions.pull && !repo.isPrivate,
        isPrivate: repo.isPrivate,
      },
      update: {
        defaultBranch: repo.defaultBranch,
        canPush: repo.permissions.push,
        canFork: repo.permissions.pull && !repo.isPrivate,
        isPrivate: repo.isPrivate,
        checkedAt: new Date(),
      },
    });
    const path = repo.archived
      ? 'none'
      : repo.permissions.push
        ? 'direct'
        : repo.permissions.pull && !repo.isPrivate
          ? 'fork'
          : 'none';
    return NextResponse.json({
      accessible: true,
      defaultBranch: repo.defaultBranch,
      archived: repo.archived,
      path,
      reason:
        path === 'direct'
          ? 'You can push a branch to this repository.'
          : path === 'fork'
            ? 'You cannot push here. RepoRevive can open the pull request from a fork if you allow it.'
            : repo.archived
              ? 'The repository is archived.'
              : 'Your account cannot contribute to this repository through RepoRevive.',
    });
  } catch (err) {
    if (err instanceof PublishError)
      return jsonError(err.code === 'AUTH_EXPIRED' ? 401 : 502, err.code, err.message);
    throw err;
  }
}
