import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Workspace } from '@/engine/core/workspace';
import {
  parseManifest,
  serializeManifest,
  withDependency,
  withoutDependency,
} from '@/engine/ecosystems/npm/manifest';
import { rewriteGitProtocols } from '@/engine/ecosystems/npm/strategies';
import { eraMatchedVersion, rangeLike } from '@/engine/ecosystems/npm/versions';
import {
  isAllowedLlmPath,
  LlmOutputSchema,
  materializeEdits,
  referencedFiles,
} from '@/engine/llm/llm-strategy';
import { RateLimiter } from '@/server/rate-limit';
import { MAX_LINE_CHARS, toStoredEvent } from '@/server/event-sink';
import { DockerSandbox } from '@/sandbox/docker-sandbox';

const packument = {
  name: 'sass',
  versions: ['1.20.0', '1.32.13', '1.33.0', '1.50.0', '2.0.0-beta.1', '1.80.0'],
  time: {
    '1.20.0': '2019-05-01T00:00:00Z',
    '1.32.13': '2021-05-12T00:00:00Z',
    '1.33.0': '2021-05-20T00:00:00Z',
    '1.50.0': '2022-04-07T00:00:00Z',
    '2.0.0-beta.1': '2022-05-01T00:00:00Z',
    '1.80.0': '2024-10-01T00:00:00Z',
  },
  distTags: { latest: '1.80.0' },
};

describe('era-matched versions', () => {
  it('picks the newest stable version published before the era date', () => {
    expect(eraMatchedVersion(packument, '2022-01-01T00:00:00Z')).toEqual({ version: '1.33.0', basis: 'era' });
    expect(eraMatchedVersion(packument, '2018-01-01T00:00:00Z', { range: '^1.33.0' })).toEqual({
      version: '1.80.0',
      basis: 'latest-in-range',
    });
    expect(
      eraMatchedVersion(packument, '2018-01-01T00:00:00Z', { range: '^1.33.0', notBefore: '2021-06-01' }),
    ).toEqual({ version: '1.33.0', basis: 'era' });
    expect(eraMatchedVersion(packument, null)).toEqual({ version: '1.80.0', basis: 'latest' });
  });

  it('keeps range style', () => {
    expect(rangeLike('~1.0.0', '1.2.3')).toBe('~1.2.3');
    expect(rangeLike('1.0.0', '1.2.3')).toBe('1.2.3');
    expect(rangeLike('latest', '1.2.3')).toBe('^1.2.3');
  });
});

describe('manifest editing', () => {
  it('preserves indentation, CRLF, trailing newline, and key order', () => {
    const raw =
      '{\r\n    "name": "x",\r\n    "dependencies": {\r\n        "b": "1",\r\n        "node-sass": "^4.0.0"\r\n    }\r\n}\r\n';
    const m = parseManifest(raw)!;
    const removed = withoutDependency(m.json, 'node-sass');
    const next = withDependency(removed.json, removed.section!, 'sass', '^1.33.0');
    expect(serializeManifest(m, next)).toBe(
      '{\r\n    "name": "x",\r\n    "dependencies": {\r\n        "b": "1",\r\n        "sass": "^1.33.0"\r\n    }\r\n}\r\n',
    );
  });

  it('rewrites git:// and ssh URLs to https', () => {
    expect(
      rewriteGitProtocols(
        '"a": "git://github.com/u/r.git#v1", "b": "git+ssh://git@github.com/u/s.git", "c": "git+git://github.com/u/t"',
      ),
    ).toBe(
      '"a": "git+https://github.com/u/r.git#v1", "b": "git+https://github.com/u/s.git", "c": "git+https://github.com/u/t"',
    );
  });
});

describe('LLM output validation', () => {
  it('only allows edits to project source files', () => {
    expect(isAllowedLlmPath('src/index.js')).toBe(true);
    for (const p of [
      'node_modules/x/index.js',
      '.git/config',
      '.github/workflows/ci.yml',
      'package-lock.json',
      '../etc/passwd',
      '/abs',
      'a b.js',
    ]) {
      expect(isAllowedLlmPath(p)).toBe(false);
    }
  });

  it('requires unique search matches and rejects malformed output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-llm-'));
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src/a.js'), 'const x = 1;\nconst x = 1;\nmodule.exports = y;\n');
      const ws = await Workspace.open(root);
      expect(
        await materializeEdits({ ws }, [{ path: 'src/a.js', search: 'const x = 1;', replace: 'z' }]),
      ).toEqual({ error: expect.stringMatching(/ambiguous/) });
      expect(
        await materializeEdits({ ws }, [
          { path: 'src/a.js', search: 'module.exports = y;', replace: 'module.exports = x;' },
        ]),
      ).toEqual({
        edits: [{ path: 'src/a.js', content: 'const x = 1;\nconst x = 1;\nmodule.exports = x;\n' }],
      });
      expect(
        await materializeEdits({ ws }, [{ path: 'node_modules/a.js', search: 'a', replace: 'b' }]),
      ).toHaveProperty('error');
      expect(LlmOutputSchema.safeParse({ edits: [] }).success).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('extracts repository files from stack traces', () => {
    expect(
      referencedFiles(
        '    at Object.<anonymous> (/workspace/src/server.js:10:5)\n    at /workspace/node_modules/x/y.js:1:1\nsrc/app.ts(3,4): error TS2322',
      ),
    ).toEqual(['src/server.js', 'src/app.ts']);
  });
});

describe('server helpers', () => {
  it('rate limiter allows N per window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(true);
    t = 1000;
    expect(rl.check('a').allowed).toBe(true);
  });

  it('truncates long log lines and strips diffs from attempt events', () => {
    const e = toStoredEvent({ type: 'log', level: 'debug', message: 'x'.repeat(5000), source: 'install' }, 7);
    expect(e.message.length).toBe(MAX_LINE_CHARS + 1);
    expect(e.seq).toBe(7);
    const a = toStoredEvent(
      {
        type: 'attempt',
        message: 'm',
        attempt: {
          seq: 1,
          issueKind: 'unknown',
          fingerprint: 'f',
          strategyId: 's',
          title: 't',
          rationale: 'r',
          status: 'VERIFIED',
          files: [],
          diff: 'huge',
          durationMs: 1,
        },
      },
      8,
    );
    expect(JSON.stringify(a.data)).not.toContain('huge');
  });
});

describe('DockerSandbox', () => {
  it('builds locked-down docker run arguments', () => {
    const sb = new DockerSandbox({ jobId: 'job1', memory: '2g', cpus: '2', pidsLimit: 512 });
    const args = sb.buildRunArgs(
      {
        image: 'node:16',
        command: ['npm', 'test'],
        workdir: path.resolve('/tmp/x'),
        network: 'none',
        timeoutMs: 1000,
        label: 'test',
        env: { CI: 'true' },
      },
      'rr-job1-test-1',
    );
    const joined = args.join(' ');
    for (const flag of [
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--read-only',
      '--network none',
      '--pids-limit 512',
      '--memory 2g',
      '--label reporevive.job=job1',
    ]) {
      expect(joined).toContain(flag);
    }
    expect(args.slice(-3)).toEqual(['node:16', 'npm', 'test']);
    expect(joined).not.toMatch(/docker\.sock/);
  });

  it('refuses unexpected images and env keys', () => {
    const sb = new DockerSandbox({ jobId: 'j', memory: '1g', cpus: '1', pidsLimit: 64 });
    const base = {
      command: ['true'],
      workdir: path.resolve('/tmp/x'),
      network: 'none' as const,
      timeoutMs: 1,
      label: 'x',
    };
    expect(() => sb.buildRunArgs({ ...base, image: 'evil/image:latest' }, 'n')).toThrow();
    expect(() => sb.buildRunArgs({ ...base, image: 'node:16', env: { 'A;B': '1' } }, 'n')).toThrow();
  });
});
