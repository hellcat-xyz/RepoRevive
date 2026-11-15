import { NextResponse, type NextRequest } from 'next/server';
import { currentUser } from '@/server/auth';
import { config } from '@/server/config';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Connection state for the UI. Never returns tokens. */
export async function GET(req: NextRequest) {
  const gh = config().github;
  if (!gh)
    return NextResponse.json(
      { configured: false, connected: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  const user = await currentUser(req);
  if (!user) {
    return NextResponse.json(
      { configured: true, connected: false },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const conn = await prisma.githubConnection.findUnique({
    where: { userId: user.id },
    select: { status: true },
  });
  const installations = await prisma.githubInstallation.findMany({
    where: { userId: user.id },
    select: { accountLogin: true, repositorySelection: true },
  });
  return NextResponse.json(
    {
      configured: true,
      connected: conn?.status === 'ACTIVE',
      connectionStatus: conn?.status ?? 'NONE',
      user: { login: user.login, avatarUrl: user.avatarUrl },
      installations,
      installUrl: gh.slug ? `https://github.com/apps/${gh.slug}/installations/new` : null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
