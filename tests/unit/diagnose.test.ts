import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepName } from '@/engine/core/types';
import {
  deprecationWarnings,
  diagnoseNpmOutput,
  gitProtocolUsages,
  splitSpec,
} from '@/engine/ecosystems/npm/diagnose';
import { ISSUE_EXPLANATIONS } from '@/engine/explanations';

const fixture = (f: string) => readFileSync(path.join(__dirname, '..', 'fixtures', f), 'utf8');

function diag(step: StepName, logTail: string, declared: string[] = [], runtimeMajor = 22) {
  return diagnoseNpmOutput({
    step,
    result: { status: 'failed', logTail, exitCode: 1 },
    declaredDeps: new Set(declared),
    runtimeMajor,
  });
}

describe('npm diagnosis', () => {
  it('detects node-sass native build failures (not a generic native-build issue)', () => {
    const issues = diag('install', fixture('node-sass-gyp.log'));
    expect(issues.map((i) => i.kind)).toEqual(['node-sass']);
  });

  it('detects generic native build failures with the package name', () => {
    const log =
      'npm error path /workspace/node_modules/bcrypt\nnpm error gyp ERR! build error\nnpm error gyp ERR! cwd /workspace/node_modules/bcrypt';
    const [issue] = diag('install', log);
    expect(issue).toMatchObject({
      kind: 'native-build',
      fingerprint: 'native-build:bcrypt',
      data: { package: 'bcrypt' },
    });
  });

  it('detects ERESOLVE peer conflicts', () => {
    expect(diag('install', fixture('eresolve.log')).map((i) => i.kind)).toEqual(['peer-conflict']);
  });

  it('detects OpenSSL 3 errors from webpack 4', () => {
    expect(diag('build', fixture('openssl-webpack4.log')).map((i) => i.kind)).toContain('openssl-legacy');
  });

  it('detects undeclared modules and missing binaries, ignoring relative paths and builtins', () => {
    const issues = diag('test', fixture('missing-module.log'), ['mocha']);
    expect(issues.map((i) => i.fingerprint).sort()).toEqual([
      'missing-binary:istanbul',
      'missing-module:chai',
    ]);
  });

  it('does not report declared packages as missing', () => {
    expect(diag('test', "Error: Cannot find module 'chai'", ['chai']).map((i) => i.kind)).toEqual([
      'test-failure',
    ]);
  });

  it('maps TS7016 to the @types package, including scoped packages', () => {
    const issues = diag(
      'build',
      "src/a.ts(1,20): error TS7016: Could not find a declaration file for module '@babel/core'.",
    );
    expect(issues[0]?.data?.package).toBe('@types/babel__core');
  });

  it('detects lockfile drift from npm ci', () => {
    const log =
      'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.\nnpm error Missing: left-pad@1.3.0 from lock file';
    expect(diag('install', log).map((i) => i.kind)).toEqual(['lockfile-drift']);
  });

  it('extracts package and range from ETARGET, handling scopes', () => {
    const [i] = diag('install', 'npm error notarget No matching version found for @scope/pkg@^9.9.9.');
    expect(i).toMatchObject({ kind: 'missing-version', data: { package: '@scope/pkg', range: '^9.9.9' } });
  });

  it('detects unpublished packages from registry 404s', () => {
    const [i] = diag(
      'install',
      'npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fgone - Not found',
    );
    expect(i).toMatchObject({ kind: 'unpublished-package', data: { package: '@acme/gone' } });
  });

  it('detects modern syntax on old runtimes only', () => {
    const log =
      "/workspace/node_modules/foo/index.js:3\n  const x = a?.b;\n             ^\nSyntaxError: Unexpected token '.'";
    expect(diag('test', log, [], 12).map((i) => i.kind)).toContain('modern-syntax');
    expect(diag('test', log, [], 22).map((i) => i.kind)).not.toContain('modern-syntax');
  });

  it('detects types incompatibility inside node_modules/@types', () => {
    const log = 'node_modules/@types/node/globals.d.ts(72,13): error TS1005: ";" expected.';
    expect(diag('build', log)[0]).toMatchObject({
      kind: 'types-incompatible',
      data: { package: '@types/node' },
    });
  });

  it('reports timeouts as timeout issues', () => {
    const issues = diagnoseNpmOutput({
      step: 'test',
      result: { status: 'timeout', logTail: 'watching…' },
      declaredDeps: new Set(),
      runtimeMajor: 22,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('timeout');
  });

  it('gives unclassified build failures a stable fingerprint', () => {
    const a = diag('build', 'Error: boom at line 12');
    const b = diag('build', 'Error: boom at line 99');
    expect(a[0]!.kind).toBe('build-failure');
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
  });

  it('never reports issues for passing steps', () => {
    expect(
      diagnoseNpmOutput({
        step: 'install',
        result: { status: 'passed', logTail: 'ERESOLVE' },
        declaredDeps: new Set(),
        runtimeMajor: 22,
      }),
    ).toEqual([]);
  });

  it('collects deprecation warnings', () => {
    expect(deprecationWarnings(fixture('node-sass-gyp.log'))).toHaveLength(2);
  });

  it('counts git:// and ssh dependency URLs', () => {
    expect(
      gitProtocolUsages(
        '"a": "git://github.com/x/y.git", "b": "git+ssh://git@github.com/x/z.git", "c": "git+https://github.com/x/w"',
      ),
    ).toBe(2);
  });

  it('splitSpec handles scoped names', () => {
    expect(splitSpec('@a/b@^1')).toEqual({ name: '@a/b', range: '^1' });
    expect(splitSpec('left-pad@1.0.0')).toEqual({ name: 'left-pad', range: '1.0.0' });
  });

  it('every issue kind has an explanation', () => {
    for (const v of Object.values(ISSUE_EXPLANATIONS)) {
      expect(v.cause.length).toBeGreaterThan(10);
      expect(v.advice.length).toBeGreaterThan(10);
    }
  });
});
