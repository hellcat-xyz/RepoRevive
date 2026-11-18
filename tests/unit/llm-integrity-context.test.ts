import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from '@/engine/core/workspace';
import { buildLlmContext, localImports, referencedFiles } from '@/engine/llm/context';
import { checkEditIntegrity } from '@/engine/llm/integrity';
import { buildUserPrompt, parseModelJson } from '@/engine/llm/openai-client';
import { editsKey } from '@/engine/pipeline';
import { makeRepo } from '../helpers/fake-world';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('edit integrity', () => {
  const test = "it('a', () => {});\nit('b', () => {});\n";

  it('accepts a normal source edit', () => {
    expect(checkEditIntegrity('src/a.js', 'const x = 1;\n', 'const x = 2;\n')).toBeNull();
    expect(checkEditIntegrity('src/new.js', null, 'module.exports = 1;\n')).toBeNull();
  });

  it('rejects removing or skipping tests', () => {
    expect(checkEditIntegrity('test/a.test.js', test, "it('a', () => {});\n")).toMatch(/removes test cases/);
    expect(checkEditIntegrity('test/a.test.js', test, test.replace("it('a'", "it.skip('a'"))).toMatch(
      /skips/,
    );
    expect(checkEditIntegrity('test/a.test.js', test, test.replace("it('a'", "xit('a'"))).toMatch(/skips/);
    expect(
      checkEditIntegrity('t.py', 'def test_a():\n  pass\n', '@pytest.mark.skip\ndef test_a():\n  pass\n'),
    ).toMatch(/skips/);
    expect(
      checkEditIntegrity(
        'a_test.go',
        'func TestA(t *testing.T) {}\n',
        'func TestA(t *testing.T) { t.Skip("x") }\n',
      ),
    ).toMatch(/skips/);
    expect(checkEditIntegrity('src/a.rs', '#[test]\nfn t() {}\n', '#[test]\n#[ignore]\nfn t() {}\n')).toMatch(
      /skips/,
    );
  });

  it('rejects forcing a step to pass and emptying files', () => {
    expect(checkEditIntegrity('Makefile', 'test:\n\tmocha\n', 'test:\n\tmocha || true\n')).toMatch(/forces/);
    expect(checkEditIntegrity('run.sh', 'mocha\n', 'mocha\nexit 0\n')).toMatch(/forces/);
    expect(checkEditIntegrity('src/a.js', 'x\n', '  \n')).toMatch(/empty/);
  });

  it('rejects new process execution, eval and secret access', () => {
    expect(checkEditIntegrity('src/a.js', 'x\n', "require('child_process').execSync('ls');\n")).toMatch(
      /process execution/,
    );
    expect(checkEditIntegrity('src/a.js', 'x\n', 'eval(code);\n')).toMatch(/eval/);
    expect(checkEditIntegrity('src/a.js', 'x\n', 'const t = process.env.GITHUB_TOKEN;\n')).toMatch(/secret/);
    expect(checkEditIntegrity('src/new.js', null, 'eval(code);\n')).toMatch(/eval/);
  });

  it('protects package.json scripts', () => {
    const before = JSON.stringify({ scripts: { build: 'tsc', test: 'mocha', postinstall: 'node x.js' } });
    const noTest = JSON.stringify({ scripts: { build: 'tsc', postinstall: 'node x.js' } });
    const echo = JSON.stringify({
      scripts: { build: 'tsc', test: 'echo skipped', postinstall: 'node x.js' },
    });
    const fine = JSON.stringify({ scripts: { build: 'tsc -p .', test: 'mocha', postinstall: 'node x.js' } });
    expect(checkEditIntegrity('package.json', before, noTest)).toMatch(/removes the "test" script/);
    expect(checkEditIntegrity('package.json', before, echo)).toMatch(/no-op/);
    expect(checkEditIntegrity('package.json', before, fine)).toBeNull();
  });

  it('P: an unchanged file is always acceptable', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        expect(checkEditIntegrity('src/a.js', text, text)).toBeNull();
      }),
    );
  });

  it('P: adding a skip marker to any test file is rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z ]{1,12}$/), { minLength: 1, maxLength: 5 }),
        fc.constantFrom('it.skip', 'xit', 'describe.skip', 'test.skip'),
        (names, marker) => {
          const before = names.map((n) => `it('${n}', () => {});`).join('\n') + '\n';
          const after = before + `${marker}('extra', () => {});\n`;
          expect(checkEditIntegrity('test/a.test.js', before, after)).not.toBeNull();
        },
      ),
    );
  });

  it('P: dropping any test case from a test file is rejected', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), fc.nat(), (n, dropRaw) => {
        const cases = Array.from({ length: n }, (_, i) => `it('case ${i}', () => {});`);
        const drop = dropRaw % n;
        const after = cases.filter((_, i) => i !== drop).join('\n') + '\n';
        expect(checkEditIntegrity('test/a.test.js', cases.join('\n') + '\n', after)).not.toBeNull();
      }),
    );
  });
});

describe('LLM context', () => {
  it('recognises files from Python, Rust, Go and Java failures', () => {
    expect(referencedFiles('  File "/workspace/app/models.py", line 3, in <module>')).toEqual([
      'app/models.py',
    ]);
    expect(referencedFiles('error[E0308]: mismatched types\n --> src/lib.rs:12:5')).toEqual(['src/lib.rs']);
    expect(referencedFiles('./cmd/main.go:12:2: undefined: foo')).toEqual(['cmd/main.go']);
    expect(
      referencedFiles('[ERROR] /workspace/src/main/java/com/a/App.java:[12,5] cannot find symbol'),
    ).toEqual(['src/main/java/com/a/App.java']);
    expect(referencedFiles('at /workspace/node_modules/x/y.js:1:1')).toEqual([]);
  });

  it('finds local imports one level deep', () => {
    const js = "import a from './a';\nconst b = require('../lib/b.js');\nimport x from 'react';";
    const found = localImports('src/ui/page.js', js);
    expect(found).toEqual(expect.arrayContaining(['src/ui/a.js', 'src/ui/a/index.js', 'src/lib/b.js']));
    expect(found.some((p) => p.includes('react'))).toBe(false);
    const py = 'from .models import User\nfrom utils.helpers import f\n';
    expect(localImports('app/views.py', py)).toEqual(
      expect.arrayContaining(['app/models.py', 'utils/helpers.py', 'app/utils/helpers.py']),
    );
  });

  it('builds a bounded context with the failing file, its imports and the repository layout', async () => {
    const repo = await makeRepo({
      'package.json': '{"name":"x"}',
      'package-lock.json': '{}',
      'src/a.js': "const b = require('./b');\n",
      'src/b.js': 'module.exports = 1;\n',
      'src/unrelated.js': 'x',
      '.env': 'SECRET=1',
      'node_modules/dep/index.js': 'x',
    });
    cleanups.push(repo.cleanup);
    const ws = await Workspace.open(repo.repoDir);
    const ctx = await buildLlmContext(
      { ws, ecosystem: { id: 'npm', packageManager: 'npm' } },
      {
        kind: 'unknown',
        fingerprint: 'f',
        step: 'test',
        severity: 'error',
        title: 't',
        evidence: '',
      },
      'Error at /workspace/src/a.js:1:1',
    );
    expect(ctx.files.map((f) => f.path)).toEqual(['package.json', 'src/a.js', 'src/b.js']);
    expect(ctx.tree).toEqual(['package.json', 'src/a.js', 'src/b.js', 'src/unrelated.js']);
    expect(ctx.tree.join(' ')).not.toMatch(/\.env|lock|node_modules/);
  });

  it('parses fenced JSON and builds a prompt with outcome detail and layout', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('{"a":2}')).toEqual({ a: 2 });
    const prompt = buildUserPrompt({
      step: 'test',
      issueTitle: 'Tests failed',
      logExcerpt: 'boom',
      files: [{ path: 'src/a.js', content: 'x' }],
      tree: ['src/a.js', 'src/b.js'],
      runtime: 'Node.js 20',
      priorAttempts: [
        { title: 'AI-proposed fix: t', status: 'REVERTED', detail: 'After this change test failed:\nnope' },
      ],
    });
    expect(prompt).toContain('--- REPOSITORY PATHS (untrusted) ---');
    expect(prompt).toContain('outcome (untrusted log): After this change test failed:');
    expect(prompt).toContain('--- FILE src/a.js (untrusted) ---');
  });

  it('P: editsKey ignores order and distinguishes content', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.stringMatching(/^[a-z]{1,6}$/), fc.string({ maxLength: 20 })), {
          minLength: 1,
          maxLength: 5,
        }),
        (pairs) => {
          const unique = [...new Map(pairs).entries()].map(([path, content]) => ({ path, content }));
          expect(editsKey(unique)).toBe(editsKey([...unique].reverse()));
          const changed = unique.map((e, i) => (i === 0 ? { ...e, content: e.content + 'x' } : e));
          expect(editsKey(changed)).not.toBe(editsKey(unique));
        },
      ),
    );
  });
});
