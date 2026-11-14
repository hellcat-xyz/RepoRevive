import { builtinModules } from 'node:module';
import type { Issue, StepName, StepResult } from '../../core/types';
import { findHttpFailures, parseLifecycleFailure, resolveScriptChain } from './lifecycle';
import { packageNameFromSpecifier } from './manifest';

export interface NpmDiagnoseInput {
  step: StepName;
  result: Pick<StepResult, 'status' | 'logTail' | 'exitCode'>;
  declaredDeps: ReadonlySet<string>;
  runtimeMajor: number;
  /** `name` from package.json; tells project scripts apart from dependency scripts. */
  projectName?: string | null;
  /** package.json `scripts`, used to locate the file behind a failing lifecycle hook. */
  scripts?: Record<string, string>;
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));

/** Binaries whose package name differs from the binary name. */
export const BINARY_PACKAGES: Record<string, string> = {
  tsc: 'typescript',
  'ts-node': 'ts-node',
  babel: '@babel/cli',
  'babel-node': '@babel/node',
  'vue-cli-service': '@vue/cli-service',
  ng: '@angular/cli',
  grunt: 'grunt-cli',
  gulp: 'gulp',
  webpack: 'webpack-cli',
  'webpack-dev-server': 'webpack-dev-server',
  'react-scripts': 'react-scripts',
  'cross-env': 'cross-env',
  rimraf: 'rimraf',
  nyc: 'nyc',
  c8: 'c8',
  jest: 'jest',
  mocha: 'mocha',
  vitest: 'vitest',
  ava: 'ava',
  karma: 'karma',
  tape: 'tape',
  tap: 'tap',
  eslint: 'eslint',
  prettier: 'prettier',
  standard: 'standard',
  xo: 'xo',
  rollup: 'rollup',
  vite: 'vite',
  parcel: 'parcel',
  'npm-run-all': 'npm-run-all',
  'run-s': 'npm-run-all',
  'run-p': 'npm-run-all',
  concurrently: 'concurrently',
  lerna: 'lerna',
  nodemon: 'nodemon',
  browserify: 'browserify',
  coffee: 'coffeescript',
  lessc: 'less',
  sass: 'sass',
  'node-sass': 'node-sass',
  tsup: 'tsup',
  esbuild: 'esbuild',
};

/** Shell built-ins and system tools we must never try to "install" from npm. */
const SYSTEM_BINARIES = new Set([
  'sh',
  'bash',
  'node',
  'npm',
  'npx',
  'git',
  'python',
  'python2',
  'python3',
  'make',
  'g++',
  'gcc',
  'cp',
  'mv',
  'rm',
  'mkdir',
  'echo',
  'cat',
  'yarn',
  'pnpm',
  'bower',
  'java',
  'docker',
  'open',
  'xdg-open',
  'sudo',
  'curl',
  'wget',
]);

function tail(text: string, re: RegExp, lines = 6): string {
  const all = text.split(/\r?\n/);
  const idx = all.findIndex((l) => re.test(l));
  if (idx === -1) return all.slice(-lines).join('\n');
  return all.slice(Math.max(0, idx - 1), idx + lines).join('\n');
}

function short(s: string): string {
  return s.length > 1200 ? s.slice(0, 1200) + '…' : s;
}

function decodePkg(raw: string): string {
  try {
    return decodeURIComponent(raw).replace(/^\//, '');
  } catch {
    return raw;
  }
}

/** Split `name@range` respecting scoped names. */
export function splitSpec(spec: string): { name: string; range: string } {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), range: spec.slice(at + 1) };
  return { name: spec, range: '' };
}

/** Diagnose one failed step. Pure and deterministic; never throws. */
export function diagnoseNpmOutput(input: NpmDiagnoseInput): Issue[] {
  const { step, result, declaredDeps, runtimeMajor } = input;
  if (result.status === 'passed' || result.status === 'skipped') return [];
  const log = result.logTail ?? '';
  const issues: Issue[] = [];
  const add = (i: Omit<Issue, 'step' | 'severity'> & { severity?: Issue['severity'] }) => {
    if (!issues.some((x) => x.fingerprint === i.fingerprint)) {
      issues.push({ severity: 'error', step, ...i, evidence: short(i.evidence) });
    }
  };

  if (result.status === 'timeout') {
    add({
      kind: 'timeout',
      fingerprint: `timeout:${step}`,
      title: `The ${step} step timed out`,
      evidence: log.split(/\r?\n/).slice(-8).join('\n'),
    });
    return issues;
  }

  // ---- install-level problems ----
  if (/\bERESOLVE\b/.test(log)) {
    add({
      kind: 'peer-conflict',
      fingerprint: 'peer-conflict',
      title: 'Peer dependency conflict (npm 7+ strict peer resolution)',
      evidence: tail(log, /ERESOLVE/, 12),
    });
  }

  if (
    /can only install (?:packages )?(?:with an existing package-lock\.json|when your package\.json and package-lock\.json)/i.test(
      log,
    ) ||
    /package\.json and package-lock\.json (?:or npm-shrinkwrap\.json )?are (?:not )?in sync/i.test(log) ||
    /Missing: \S+ from lock file/.test(log) ||
    /Invalid: lock file's \S+ does not satisfy/.test(log)
  ) {
    add({
      kind: 'lockfile-drift',
      fingerprint: 'lockfile-drift',
      title: 'package-lock.json is out of sync with package.json',
      evidence: tail(log, /in sync|from lock file|does not satisfy/),
    });
  }

  if (
    /git:\/\/github\.com/i.test(log) &&
    /(unable to connect|unauthenticated git protocol|Connection (?:timed out|refused)|ls-remote|exited with error code: 128)/i.test(
      log,
    )
  ) {
    add({
      kind: 'git-protocol',
      fingerprint: 'git-protocol',
      title: 'Dependency uses the retired git:// protocol',
      evidence: tail(log, /git:\/\//),
    });
  }

  for (const m of log.matchAll(/No matching version found for (\S+?)\.?(?:\s|$)/g)) {
    const { name, range } = splitSpec(m[1]!);
    add({
      kind: 'missing-version',
      fingerprint: `missing-version:${name}`,
      title: `No published version of ${name} matches "${range}"`,
      evidence: m[0],
      data: { package: name, range },
    });
  }

  for (const m of log.matchAll(/404 Not Found - GET https?:\/\/registry\.npmjs\.org\/(\S+?)(?: - |\s|$)/g)) {
    const name = decodePkg(m[1]!).replace(/\/-\/.*$/, '');
    add({
      kind: 'unpublished-package',
      fingerprint: `unpublished-package:${name}`,
      title: `${name} is no longer available on the npm registry`,
      evidence: m[0],
      data: { package: name },
      severity: 'critical',
    });
  }

  const nodeSass =
    /node-sass/.test(log) &&
    /(gyp ERR!|Node Sass does not yet support|binding\.node|node-sass@[\d.]+ (?:postinstall|install))/.test(
      log,
    );
  if (nodeSass) {
    add({
      kind: 'node-sass',
      fingerprint: 'node-sass',
      title: `node-sass cannot be built on Node.js ${runtimeMajor}`,
      evidence: tail(log, /node-sass|Node Sass/, 10),
    });
  } else if (/gyp ERR!/.test(log)) {
    const pkg =
      /gyp ERR! cwd \/workspace\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/.exec(log)?.[1] ??
      /npm (?:ERR!|error) path \/workspace\/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/.exec(log)?.[1] ??
      'unknown';
    add({
      kind: 'native-build',
      fingerprint: `native-build:${pkg}`,
      title: `Native module ${pkg === 'unknown' ? '' : pkg + ' '}failed to compile on Node.js ${runtimeMajor}`,
      evidence: tail(log, /gyp ERR!/, 10),
      data: { package: pkg },
    });
  }

  if (/ERR_OSSL_EVP_UNSUPPORTED|digital envelope routines::unsupported/.test(log)) {
    add({
      kind: 'openssl-legacy',
      fingerprint: 'openssl-legacy',
      title: 'Build tooling uses a hash algorithm removed in OpenSSL 3 (Node 17+)',
      evidence: tail(log, /ERR_OSSL|digital envelope/),
    });
  }

  const wanted = [...log.matchAll(/Unsupported engine[\s\S]{0,200}?wanted: \{"node":"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
  const yarnWanted = [
    ...log.matchAll(/The engine "node" is incompatible with this module\. Expected version "([^"]+)"/g),
  ].map((m) => m[1]!);
  const wantedRanges = [...wanted, ...yarnWanted];
  if (/\bEBADENGINE\b/.test(log) && /npm (?:ERR!|error) code EBADENGINE/.test(log)) {
    add({
      kind: 'engine-mismatch',
      fingerprint: 'engine-mismatch',
      title: `A dependency requires a different Node.js version than ${runtimeMajor}`,
      evidence: tail(log, /EBADENGINE|Unsupported engine/),
      data: { wanted: wantedRanges.join(' || ') },
    });
  }

  const modern =
    /SyntaxError: Unexpected token ['"]?(?:\?|\.|\?\?=|\|\|=|&&=|#)['"]?/.test(log) ||
    /SyntaxError: Unexpected (?:reserved word|identifier)/.test(log) ||
    /ReferenceError: (?:structuredClone|fetch|AbortController|globalThis|TextEncoder|TextDecoder|ReadableStream|Blob|FormData) is not defined/.test(
      log,
    ) ||
    /ERR_UNKNOWN_BUILTIN_MODULE|Cannot find module 'node:[a-z_/]+'/.test(log) ||
    /SyntaxError: Cannot use import statement outside a module[\s\S]{0,300}node_modules/.test(log);
  if (modern && runtimeMajor < 22) {
    add({
      kind: 'modern-syntax',
      fingerprint: 'modern-syntax',
      title: `Code requires a newer JavaScript runtime than Node.js ${runtimeMajor}`,
      evidence: tail(log, /SyntaxError|ReferenceError|ERR_UNKNOWN_BUILTIN_MODULE|node:/),
      data: { wanted: wantedRanges.join(' || ') },
    });
  }

  // ---- build/test-level problems ----
  const missingModuleRes = [
    /Cannot find module '([^']+)'/g,
    /Module not found: Error: Can't resolve '([^']+)'/g,
    /Cannot find package '([^']+)' imported from/g,
    /error TS2307: Cannot find module '([^']+)'/g,
  ];
  for (const re of missingModuleRes) {
    for (const m of log.matchAll(re)) {
      const name = packageNameFromSpecifier(m[1]!);
      if (!name || BUILTINS.has(name) || declaredDeps.has(name)) continue;
      add({
        kind: 'missing-module',
        fingerprint: `missing-module:${name}`,
        title: `Code imports "${name}" but it is not declared as a dependency`,
        evidence: tail(log, new RegExp(escapeRe(m[0]))),
        data: { package: name },
      });
    }
  }
  for (const m of log.matchAll(/error TS7016: Could not find a declaration file for module '([^']+)'/g)) {
    const base = packageNameFromSpecifier(m[1]!);
    if (!base) continue;
    const typesName = base.startsWith('@') ? `@types/${base.slice(1).replace('/', '__')}` : `@types/${base}`;
    if (declaredDeps.has(typesName)) continue;
    add({
      kind: 'missing-module',
      fingerprint: `missing-module:${typesName}`,
      title: `Type declarations for "${base}" are missing`,
      evidence: m[0],
      data: { package: typesName },
    });
  }

  for (const m of log.matchAll(
    /(?:sh: (?:\d+: )?|\/bin\/sh: (?:\d+: )?)([\w.@/-]+): (?:command )?not found/g,
  )) {
    const bin = m[1]!.split('/').pop()!;
    if (SYSTEM_BINARIES.has(bin)) continue;
    const pkg = BINARY_PACKAGES[bin] ?? bin;
    if (declaredDeps.has(pkg) && !BINARY_PACKAGES[bin]) continue;
    add({
      kind: 'missing-binary',
      fingerprint: `missing-binary:${bin}`,
      title: `The "${bin}" command is not installed`,
      evidence: m[0],
      data: { binary: bin, package: pkg },
    });
  }

  const typesSeen = new Set<string>();
  for (const m of log.matchAll(
    /node_modules\/(@types\/[\w.-]+)\/[^\s(:]*(?:\(\d+,\d+\)|:\d+:\d+)[\s\S]{0,20}?error TS\d+/g,
  )) {
    const pkg = m[1]!;
    if (typesSeen.has(pkg)) continue;
    typesSeen.add(pkg);
    add({
      kind: 'types-incompatible',
      fingerprint: `types-incompatible:${pkg}`,
      title: `${pkg} is newer than the project's TypeScript version supports`,
      evidence: tail(log, new RegExp(escapeRe(pkg))),
      data: { package: pkg },
    });
  }

  if (
    issues.length === 0 &&
    step === 'install' &&
    /\b(ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|network request to .* failed)\b/.test(
      log,
    )
  ) {
    add({
      kind: 'network',
      fingerprint: 'network:install',
      title: 'Network failure while downloading dependencies',
      evidence: tail(log, /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|network/),
      severity: 'warning',
    });
  }

  diagnoseStructured(input, log, add, issues);

  if (issues.length === 0) {
    const lastError =
      log
        .split(/\r?\n/)
        .reverse()
        .find((l) => /error|ERR!|failed|exception/i.test(l)) ?? `exit code ${result.exitCode ?? '?'}`;
    add({
      kind: 'unknown',
      fingerprint: `unknown:${step}:${hash(lastError.replace(/\d+/g, '#'))}`,
      title: `The ${step} step failed`,
      evidence: log.split(/\r?\n/).slice(-25).join('\n'),
    });
  }
  return issues;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Deprecation warnings printed during install (informational). */
export function deprecationWarnings(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/npm (?:WARN|warn) deprecated ([^\r\n]+)/g))
    out.add(m[1]!.trim().slice(0, 300));
  return [...out].slice(0, 50);
}

/** Proactive detection from files: dependencies fetched over the retired git:// or ssh protocols. */
export function gitProtocolUsages(text: string): number {
  return (text.match(/(?:git\+)?(?:git:\/\/github\.com\/|ssh:\/\/git@github\.com[/:])/g) ?? []).length;
}

type AddIssue = (i: Omit<Issue, 'step' | 'severity'> & { severity?: Issue['severity'] }) => void;

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const TS_ERROR = /^(.*?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))?\s*[:-]\s*error (TS\d+): (.+)$/;
/** Codes that other rules already own (missing modules, missing declarations). */
const TS_OWNED_ELSEWHERE = new Set(['TS2307', 'TS7016']);
const TS_API_CODES = new Set(['TS2305', 'TS2724', 'TS2614']);

/**
 * Rules that produce structured diagnostics (script, file, command, HTTP status). Runs after the
 * older pattern rules and, when nothing at all matched, supplies step-level fallbacks so that
 * `unknown` is reserved for failures we genuinely cannot describe.
 */
function diagnoseStructured(input: NpmDiagnoseInput, log: string, add: AddIssue, issues: Issue[]): void {
  const { step } = input;
  const scripts = input.scripts ?? {};
  const lifecycle = step === 'install' ? parseLifecycleFailure(log) : null;
  const ownedByProject = !lifecycle || !input.projectName || lifecycle.package === input.projectName;
  const scriptFile =
    lifecycle?.file ?? (lifecycle ? (resolveScriptChain(scripts, lifecycle.hook)[0] ?? null) : null);

  // Broken external resource: a script downloads something that now answers 404/410.
  const http =
    step === 'test'
      ? []
      : findHttpFailures(log).filter(
          (h) =>
            lifecycle !== null || /download|fetch|retriev|request|\bGET\b|curl|wget|unable/i.test(h.line),
        );
  if (http.length > 0) {
    const resources = [...new Set(http.flatMap((h) => h.resources))].sort();
    const status = http[0]!.status;
    const where = lifecycle
      ? `${lifecycle.hook} script${scriptFile ? ` ${scriptFile}` : ''}`
      : `${step} step`;
    add({
      kind: 'broken-upstream-resource',
      fingerprint: `broken-upstream-resource:${resources.join(',') || hash(http[0]!.line.replace(/\d+/g, '#'))}`,
      title: `The ${where} downloads a resource that no longer exists (HTTP ${status}${
        resources.length ? `: ${resources.join(', ')}` : ''
      })`,
      evidence: tail(log, /HTTP\s*(?:status\s*)?(?:code\s*)?[:=]?\s*(?:404|410)|404 Not Found|410 Gone/i, 8),
      data: {
        ...(scriptFile ? { file: scriptFile } : {}),
        ...(lifecycle ? { lifecycle: lifecycle.hook, package: lifecycle.package } : {}),
        owner: ownedByProject ? 'project' : 'dependency',
        httpStatus: String(status),
        resources: resources.join(','),
      },
      diagnostic: {
        category: 'upstream-resource',
        message: http[0]!.line,
        command: lifecycle?.command ?? undefined,
        file: scriptFile ?? undefined,
        lifecycle: lifecycle?.hook,
        package: lifecycle?.package,
        httpStatus: status,
        resources,
      },
    });
  }

  if (
    /\bEJSONPARSE\b|code EINTEGRITY|\bELOCKVERIFY\b|Invalid (?:package-lock|lockfile)/i.test(log) &&
    /package-lock|npm-shrinkwrap|EINTEGRITY|lockfile/i.test(log)
  ) {
    add({
      kind: 'lockfile-corrupt',
      fingerprint: 'lockfile-corrupt',
      title: 'The lockfile is unreadable or fails its integrity checks',
      evidence: tail(log, /EJSONPARSE|EINTEGRITY|ELOCKVERIFY|Invalid (?:package-lock|lockfile)/i, 6),
      diagnostic: {
        category: 'lockfile',
        message: 'package-lock.json could not be parsed or verified',
        file: 'package-lock.json',
      },
    });
  }

  for (const m of log.matchAll(/(?:Missing script|missing script):?\s*"?([\w:.-]+)"?/g)) {
    add({
      kind: 'missing-script',
      fingerprint: `missing-script:${m[1]}`,
      title: `package.json has no "${m[1]}" script`,
      evidence: m[0],
      data: { script: m[1]! },
      diagnostic: { category: 'script', message: m[0], file: 'package.json' },
    });
  }

  for (const m of log.matchAll(
    /ENOENT: no such file or directory, (?:open|stat|lstat|scandir|copyfile|readdir|access) '([^']+)'/g,
  )) {
    const raw = m[1]!;
    if (!raw.startsWith('/workspace/') || raw.includes('/node_modules/')) continue;
    const rel = raw.slice('/workspace/'.length);
    add({
      kind: 'missing-file',
      fingerprint: `missing-file:${rel}`,
      title: `A file the ${step} step needs does not exist: ${rel}`,
      evidence: tail(log, new RegExp(escapeRe(rel))),
      data: { file: rel },
      diagnostic: { category: 'missing-file', message: m[0], file: rel },
    });
  }

  const tsErrors = log
    .split(/\r?\n/)
    .map((l) => TS_ERROR.exec(l.replace(ANSI, '')))
    .filter((m): m is RegExpExecArray => m !== null)
    .filter((m) => !TS_OWNED_ELSEWHERE.has(m[6]!) && !m[1]!.includes('node_modules'));
  if (tsErrors.length > 0 && !issues.some((i) => i.kind === 'types-incompatible')) {
    const first = tsErrors[0]!;
    add({
      kind: 'typescript-error',
      fingerprint: `typescript-error:${step}`,
      title: `TypeScript reported ${tsErrors.length} error${tsErrors.length === 1 ? '' : 's'} during ${step}`,
      evidence: tsErrors
        .slice(0, 6)
        .map((m) => m[0])
        .join('\n'),
      data: { file: first[1]!.trim(), codes: [...new Set(tsErrors.map((m) => m[6]!))].slice(0, 8).join(',') },
      diagnostic: { category: 'typescript', message: first[7]!, file: first[1]!.trim() || undefined },
    });
  }

  const apiChanges: { pkg: string; message: string }[] = [];
  for (const m of log.matchAll(/The requested module '([^']+)' does not provide an export named '([^']+)'/g))
    apiChanges.push({ pkg: m[1]!, message: m[0] });
  for (const m of log.matchAll(/"([^"]+)" is not exported by "([^"]+)"/g))
    apiChanges.push({ pkg: m[2]!, message: m[0] });
  for (const m of tsErrors.filter((t) => TS_API_CODES.has(t[6]!))) {
    const mod = /module ['"]([^'"]+)['"]/.exec(m[7]!)?.[1];
    if (mod) apiChanges.push({ pkg: mod, message: m[0] });
  }
  for (const a of apiChanges) {
    const name = packageNameFromSpecifier(a.pkg.replace(/^.*node_modules\//, ''));
    if (!name || BUILTINS.has(name)) continue;
    add({
      kind: 'dependency-api-change',
      fingerprint: `dependency-api-change:${name}`,
      title: `Code uses an API that the installed ${name} no longer provides`,
      evidence: a.message,
      data: { package: name },
      diagnostic: { category: 'dependency-api', message: a.message, package: name },
    });
  }

  if (issues.length > 0) return;

  // Step-level fallbacks: still more useful than "The step failed".
  if (lifecycle) {
    add({
      kind: 'lifecycle-script-failure',
      fingerprint: `lifecycle-script-failure:${lifecycle.package}:${lifecycle.hook}`,
      title: `The ${lifecycle.hook} script of ${lifecycle.package} failed${
        lifecycle.command ? ` while running \`${lifecycle.command}\`` : ''
      }`,
      evidence: log.split(/\r?\n/).slice(-25).join('\n'),
      data: {
        lifecycle: lifecycle.hook,
        package: lifecycle.package,
        owner: ownedByProject ? 'project' : 'dependency',
        ...(scriptFile ? { file: scriptFile } : {}),
      },
      diagnostic: {
        category: 'lifecycle-script',
        message: `${lifecycle.hook} exited with an error`,
        command: lifecycle.command ?? undefined,
        file: scriptFile ?? undefined,
        lifecycle: lifecycle.hook,
        package: lifecycle.package,
      },
    });
    return;
  }
  if (step === 'build' || step === 'test') {
    const lastError =
      log
        .split(/\r?\n/)
        .reverse()
        .find((l) => /error|ERR!|fail|exception/i.test(l)) ?? `exit code ${input.result.exitCode ?? '?'}`;
    const kind = step === 'build' ? 'build-failure' : 'test-failure';
    add({
      kind,
      fingerprint: `${kind}:${hash(lastError.replace(/\d+/g, '#'))}`,
      title: step === 'build' ? 'The build script failed' : 'The test suite failed',
      evidence: log.split(/\r?\n/).slice(-25).join('\n'),
      diagnostic: {
        category: step,
        message: lastError.trim().slice(0, 300),
        command: input.result.exitCode !== undefined ? `exit ${input.result.exitCode}` : undefined,
      },
    });
  }
}
