import type { PrismaClient } from '@prisma/client';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canMutate, canView, type SessionUser } from '@/server/auth';
import { applyPublicationAction } from '@/server/publications';

const user = (id: string): SessionUser => ({ id, login: id, avatarUrl: null });

describe('job ownership', () => {
  it('owned jobs are invisible and immutable to other users and anonymous visitors', () => {
    expect(canView({ ownerId: 'u1' }, user('u1'))).toBe(true);
    expect(canView({ ownerId: 'u1' }, user('u2'))).toBe(false);
    expect(canView({ ownerId: 'u1' }, null)).toBe(false);
    expect(canMutate({ ownerId: 'u1' }, user('u2'))).toBe(false);
    expect(canMutate({ ownerId: 'u1' }, null)).toBe(false);
  });
  it('historic anonymous jobs keep working', () => {
    expect(canView({ ownerId: null }, null)).toBe(true);
    expect(canMutate({ ownerId: null }, null)).toBe(true);
  });
  it('P: a non-owner never gets access to an owned job', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
        (owner, actor) => {
          if (actor !== owner) {
            expect(canView({ ownerId: owner }, actor ? user(actor) : null)).toBe(false);
            expect(canMutate({ ownerId: owner }, actor ? user(actor) : null)).toBe(false);
          }
        },
      ),
    );
  });
});

function fakeDb(row: { status: string; attempts?: number; allowFork?: boolean } | null) {
  const state = row ? { id: 'p1', attempts: 0, allowFork: false, ...row } : null;
  const db = {
    publication: {
      findUnique: async () => state,
      updateMany: async ({ where, data }: { where: { status: string }; data: Record<string, unknown> }) => {
        if (!state || state.status !== where.status) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    },
    $executeRaw: async () => 1,
  };
  return { db: db as unknown as PrismaClient, state };
}

describe('publication actions', () => {
  it('approve only moves PENDING_APPROVAL to QUEUED, and needs an active GitHub connection', async () => {
    const a = fakeDb({ status: 'PENDING_APPROVAL' });
    expect(await applyPublicationAction(a.db, 'j', 'approve', { connectionActive: false })).toMatchObject({
      ok: false,
      error: { code: 'AUTH_REQUIRED' },
    });
    expect(a.state!.status).toBe('PENDING_APPROVAL');
    expect(
      await applyPublicationAction(a.db, 'j', 'approve', { connectionActive: true, allowFork: true }),
    ).toMatchObject({ ok: true, status: 'QUEUED' });
    expect(a.state).toMatchObject({ status: 'QUEUED', allowFork: true });
    // A second click cannot queue it twice.
    expect(await applyPublicationAction(a.db, 'j', 'approve', { connectionActive: true })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
  });
  it('cannot approve a blocked publication or retry a created one', async () => {
    expect(
      await applyPublicationAction(fakeDb({ status: 'BLOCKED' }).db, 'j', 'approve', {
        connectionActive: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await applyPublicationAction(fakeDb({ status: 'CREATED' }).db, 'j', 'retry', {
        connectionActive: true,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await applyPublicationAction(fakeDb({ status: 'CREATED' }).db, 'j', 'cancel', {
        connectionActive: true,
      }),
    ).toMatchObject({ ok: false });
  });
  it('retry is bounded', async () => {
    expect(
      await applyPublicationAction(fakeDb({ status: 'FAILED', attempts: 5 }).db, 'j', 'retry', {
        connectionActive: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'RETRY_LIMIT' } });
    const ok = fakeDb({ status: 'FAILED', attempts: 2 });
    expect(await applyPublicationAction(ok.db, 'j', 'retry', { connectionActive: true })).toMatchObject({
      ok: true,
      status: 'QUEUED',
    });
  });
  it('returns 404 when there is no publication', async () => {
    expect(
      await applyPublicationAction(fakeDb(null).db, 'j', 'approve', { connectionActive: true }),
    ).toMatchObject({ error: { http: 404 } });
  });
});
