import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IssueKind, StepName } from '@/engine/core/types';
import { diagnoseNpmOutput } from '@/engine/ecosystems/npm/diagnose';
import {
  findHttpFailures,
  parseLifecycleFailure,
  resolveScriptChain,
  scriptFileFromCommand,
} from '@/engine/ecosystems/npm/lifecycle';
import { ISSUE_EXPLANATIONS } from '@/engine/explanations';

const fixture = (f: string) => readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8');

const SCRIPTS = {
  postinstall: 'npm run build:hyperspeed',
  'build:hyperspeed': 'node scripts/build-reactbits-hyperspeed.mjs',
  build: 'tsc',
};

function diag(step: StepName, logTail: string, extra: { projectName?: string | null } = {}) {
  return diagnoseNpmOutput({
    step,
    result: { status: 'failed', logTail, exitCode: 1 },
    declaredDeps: new Set(),
    runtimeMajor: 22,
    scripts: SCRIPTS,
    projectName: 'outcomeai-login',
    ...extra,
  });
}

describe('lifecycle parsing', () => {
  it('finds the failing postinstall chain in the OrexisAI log', () => {
    expect(parseLifecycleFailure(fixture('orexis-postinstall-404.log'))).toEqual({
      hook: 'postinstall',
      package: 'outcomeai-login',
      command: 'node scripts/build-reactbits-hyperspeed.mjs',
      file: 'scripts/build-reactbits-hyperspeed.mjs',
    });
  });

  it('returns null when no lifecycle hook ran', () => {
    expect(parseLifecycleFailure('> app@1.0.0 build\n> tsc\nerror')).toBeNull();
  });

  it('extracts script files from commands and rejects unsafe ones', () => {
    expect(scriptFileFromCommand('node ./scripts/a.mjs --x')).toBe('scripts/a.mjs');
    expect(scriptFileFromCommand('cross-env A=1 node --trace-warnings s/b.cjs')).toBe('s/b.cjs');
    expect(scriptFileFromCommand('node ../evil.js')).toBeNull();
    expect(scriptFileFromCommand('node /etc/passwd.js')).toBeNull();
    expect(scriptFileFromCommand('rm -rf x.js')).toBeNull();
  });

  it('expands npm run chains from package.json', () => {
    expect(resolveScriptChain(SCRIPTS, 'postinstall')).toEqual(['scripts/build-reactbits-hyperspeed.mjs']);
    expect(resolveScriptChain({ a: 'npm run a' }, 'a')).toEqual([]); // cycles terminate
  });

  it('ignores npm registry 404s when looking for HTTP failures', () => {
    expect(findHttpFailures('npm error 404 Not Found - GET https://registry.npmjs.org/x')).toEqual([]);
    expect(findHttpFailures('Unable to download a.js: HTTP 404')[0]).toMatchObject({
      status: 404,
      resources: ['a.js'],
    });
  });
});

describe('structured diagnosis', () => {
  it('identifies the OrexisAI failure as a broken upstream resource, not "The install step failed"', () => {
    const issues = diag('install', fixture('orexis-postinstall-404.log'));
    expect(issues.map((i) => i.kind)).toEqual(['broken-upstream-resource']);
    const [issue] = issues;
    expect(issue!.title).not.toMatch(/The install step failed/);
    expect(issue!.diagnostic).toMatchObject({
      category: 'upstream-resource',
      file: 'scripts/build-reactbits-hyperspeed.mjs',
      lifecycle: 'postinstall',
      command: 'node scripts/build-reactbits-hyperspeed.mjs',
      httpStatus: 404,
      resources: ['HyperSpeedPresets.js'],
    });
    expect(issue!.data).toMatchObject({ owner: 'project', file: 'scripts/build-reactbits-hyperspeed.mjs' });
    expect(issue!.fingerprint).toBe('broken-upstream-resource:HyperSpeedPresets.js');
  });

  it('marks dependency-owned scripts as such', () => {
    const [issue] = diag('install', fixture('orexis-postinstall-404.log'), { projectName: 'something-else' });
    expect(issue!.data?.owner).toBe('dependency');
  });

  it('does not treat HTTP 404 text in test output as a broken download', () => {
    const issues = diag('test', 'FAIL api.test.js\n  expected HTTP 404 but got 200\nTests: 1 failed');
    expect(issues.map((i) => i.kind)).toEqual(['test-failure']);
  });

  it('reports a generic failing lifecycle script with its command and file', () => {
    const log =
      '> outcomeai-login@3.0.0 postinstall\n> node scripts/setup.mjs\n\nError: boom\nnpm error code 1';
    const [issue] = diag('install', log);
    expect(issue).toMatchObject({
      kind: 'lifecycle-script-failure',
      diagnostic: { lifecycle: 'postinstall', file: 'scripts/setup.mjs', command: 'node scripts/setup.mjs' },
    });
  });

  it('detects missing scripts', () => {
    const [i] = diag('build', 'npm error Missing script: "compile"');
    expect(i).toMatchObject({ kind: 'missing-script', data: { script: 'compile' } });
  });

  it('detects missing files inside the workspace only', () => {
    const log =
      "Error: ENOENT: no such file or directory, open '/workspace/public/data.json'\n" +
      "Error: ENOENT: no such file or directory, open '/workspace/node_modules/x/y.js'";
    expect(diag('build', log).map((i) => [i.kind, i.data?.file])).toEqual([
      ['missing-file', 'public/data.json'],
    ]);
  });

  it('detects corrupt lockfiles', () => {
    const [i] = diag('install', 'npm error code EJSONPARSE\nnpm error JSON.parse Invalid package-lock.json');
    expect(i!.kind).toBe('lockfile-corrupt');
  });

  it('detects TypeScript compile errors', () => {
    const log = "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const [i] = diag('build', log);
    expect(i).toMatchObject({ kind: 'typescript-error', diagnostic: { file: 'src/a.ts' } });
  });

  it('detects dependency API changes', () => {
    const log = "SyntaxError: The requested module 'lodash' does not provide an export named 'chain2'";
    const [i] = diag('test', log);
    expect(i).toMatchObject({ kind: 'dependency-api-change', data: { package: 'lodash' } });
  });

  it('keeps "unknown" for unclassifiable install failures only', () => {
    expect(diag('install', 'something odd happened')[0]!.kind).toBe('unknown');
  });

  it('has a human explanation for every new kind', () => {
    const kinds: IssueKind[] = [
      'lifecycle-script-failure',
      'broken-upstream-resource',
      'missing-file',
      'missing-script',
      'lockfile-corrupt',
      'typescript-error',
      'dependency-api-change',
      'build-failure',
      'test-failure',
    ];
    for (const k of kinds) {
      expect(ISSUE_EXPLANATIONS[k].cause.length).toBeGreaterThan(20);
      expect(ISSUE_EXPLANATIONS[k].advice.length).toBeGreaterThan(10);
    }
  });
});
