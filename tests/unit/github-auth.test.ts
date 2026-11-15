import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildPrBody, prTitle, redactSecrets } from '@/engine/publish/body';
import { loadConfig } from '@/server/config';
import { decryptSecret, encryptSecret, signValue, verifyValue } from '@/server/github/crypto';
import {
  authorizeUrl,
  checkState,
  newState,
  safeReturnTo,
  sessionCookieValue,
  sessionUserId,
} from '@/server/github/oauth';
import type { ResurrectionReport } from '@/engine/report';

const key = randomBytes(32);
const cfg = {
  clientId: 'Iv1.abc',
  clientSecret: 's',
  slug: 'reporevive',
  baseUrl: 'https://app.example.com',
  sessionSecret: 'x'.repeat(40),
  encryptionKey: key,
};

describe('token encryption', () => {
  it('P: round-trips and never stores plaintext', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (secret, aad) => {
          const blob = encryptSecret(secret, key, aad);
          expect(blob).not.toContain(secret.length > 3 ? secret : '\u0000');
          expect(decryptSecret(blob, key, aad)).toBe(secret);
        },
      ),
    );
  });
  it('rejects tampering, wrong key, and a different user context', () => {
    const blob = encryptSecret('ghu_token', key, 'user1');
    expect(() => decryptSecret(blob, key, 'user2')).toThrow();
    expect(() => decryptSecret(blob, randomBytes(32), 'user1')).toThrow();
    const parts = blob.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key, 'user1')).toThrow();
  });
});

describe('OAuth state and sessions', () => {
  it('accepts only the state bound to this browser, once signed and unexpired', () => {
    const { state, cookie } = newState(cfg);
    expect(checkState(cfg, cookie, state)).toBe(true);
    expect(checkState(cfg, cookie, 'f'.repeat(64))).toBe(false);
    expect(checkState(cfg, undefined, state)).toBe(false);
    expect(checkState(cfg, cookie, null)).toBe(false);
    expect(checkState({ sessionSecret: 'y'.repeat(40) }, cookie, state)).toBe(false);
    expect(checkState(cfg, cookie, state, Date.now() + 11 * 60_000)).toBe(false); // expired
  });
  it('states are unique and unguessable', () => {
    const s = new Set(Array.from({ length: 50 }, () => newState(cfg).state));
    expect(s.size).toBe(50);
    expect([...s][0]).toMatch(/^[0-9a-f]{64}$/);
  });
  it('sessions reject tampering and expiry', () => {
    const c = sessionCookieValue(cfg, 'user1');
    expect(sessionUserId(cfg, c)).toBe('user1');
    expect(sessionUserId(cfg, c.replace('user1', 'user2'))).toBeNull();
    expect(sessionUserId(cfg, c, Date.now() + 31 * 24 * 3600 * 1000)).toBeNull();
    expect(verifyValue(cfg.sessionSecret, 'other-purpose', c)).toBeNull();
    expect(() => signValue('s', 'p', 'a.b', 10)).toThrow();
  });
  it('P: safeReturnTo never yields an off-site target', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const r = safeReturnTo(s);
        expect(r.startsWith('/')).toBe(true);
        expect(r.startsWith('//')).toBe(false);
        expect(r.includes('\\')).toBe(false);
      }),
    );
    expect(safeReturnTo('//evil.com')).toBe('/');
    expect(safeReturnTo('/r/abc')).toBe('/r/abc');
  });
  it('authorize URL carries client id, callback and state only', () => {
    const u = new URL(authorizeUrl(cfg, 'st'));
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/github/callback');
    expect(u.searchParams.get('client_secret')).toBeNull();
  });
});

describe('github config', () => {
  const base = { DATABASE_URL: 'postgresql://x' };
  it('is off unless fully configured, and rejects partial or weak settings', () => {
    expect(loadConfig(base).github).toBeNull();
    expect(() => loadConfig({ ...base, GITHUB_APP_CLIENT_ID: 'x' })).toThrow(/must all be set/);
    const full = {
      ...base,
      GITHUB_APP_CLIENT_ID: 'id',
      GITHUB_APP_CLIENT_SECRET: 'secret',
      APP_BASE_URL: 'http://localhost:3000/',
      SESSION_SECRET: 's'.repeat(32),
      TOKEN_ENCRYPTION_KEY: key.toString('base64'),
    };
    expect(loadConfig(full).github?.baseUrl).toBe('http://localhost:3000');
    expect(() =>
      loadConfig({ ...full, TOKEN_ENCRYPTION_KEY: Buffer.from('short').toString('base64') }),
    ).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...full, SESSION_SECRET: 'short' })).toThrow();
  });
});

describe('.env.example', () => {
  it('parses as a valid configuration with GitHub disabled', () => {
    const env: Record<string, string> = {};
    for (const line of readFileSync('.env.example', 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
    }
    const cfg = loadConfig(env);
    expect(cfg.github).toBeNull();
    expect(cfg.databaseUrl).toMatch(/^postgresql:\/\//);
  });
});

describe('PR content', () => {
  const step = (status: string, skipReason?: string) => ({
    status,
    skipReason,
    durationMs: 0,
    logTail: 'secret log ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  });
  const report = {
    health: 'REVIVED',
    headline: 'Revived. 1 verified fix brought every step back to life.',
    ecosystem: 'python',
    repo: { owner: 'a', name: 'b', url: 'u', commitSha: 'a'.repeat(40), commitDate: null },
    analysis: { ecosystem: 'python', packageManager: 'pip' },
    runtime: { baseline: 'python:3.11-slim', final: 'python:3.7-slim' },
    rootCauses: [
      {
        kind: 'missing-version',
        title: 'No release of x',
        step: 'install',
        cause: 'c',
        evidence: 'e',
        resolved: true,
      },
    ],
    attempts: [{ seq: 1, status: 'VERIFIED', title: 'Pin Python 3.7', files: ['.python-version'] }],
    modifiedFiles: [{ path: '.python-version', status: 'added', additions: 1, deletions: 0 }],
    verification: {
      baseline: {
        runtime: 'x',
        score: 0,
        steps: { install: step('passed'), build: step('passed'), test: step('failed') },
      },
      final: {
        runtime: 'x',
        score: 100,
        steps: { install: step('passed'), build: step('passed'), test: step('skipped', 'no-test-suite') },
      },
    },
    coverage: {
      level: 'build-only',
      testedFunctionally: false,
      limitations: ['No automated test suite was found, so behaviour was not tested.'],
    },
    remainingIssues: [],
    warnings: ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked'],
  } as unknown as ResurrectionReport;

  it('is honest about skipped tests, never mentions CI success, and carries attribution', () => {
    const body = buildPrBody({
      report,
      baseBranch: 'main',
      excluded: [{ path: '.github/workflows/ci.yml', reason: 'not published' }],
      reportUrl: null,
      jobId: 'job1',
    });
    expect(body).toMatch(/generated automatically by \[RepoRevive\]/);
    expect(body).toMatch(/test: skipped, no test suite found/);
    expect(body).not.toMatch(/tests? pass(ed)?\b/i);
    expect(body).toMatch(/not\*\* a GitHub Actions run/);
    expect(body).toMatch(/behaviour not functionally tested/);
    expect(body).toContain('.github/workflows/ci.yml');
    expect(body).not.toContain('ghp_');
    expect(body).not.toContain('secret log');
    expect(prTitle(report)).toBe('fix(revive): restore compatibility and build verification');
  });
  it('P: redaction removes token-shaped strings', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9]{36}$/), (t) => {
        expect(redactSecrets(`x ghp_${t} y`)).not.toContain(`ghp_${t}`);
        expect(redactSecrets(`Bearer ${t}${t}`)).not.toContain(t);
      }),
    );
  });
});
