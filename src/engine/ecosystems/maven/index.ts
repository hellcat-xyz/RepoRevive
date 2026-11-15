import { createHash } from 'node:crypto';
import { pickEraVersion } from '../../core/era';
import type { FileEdit, Issue, IssueKind, RuntimeSelection, StepName, StepResult } from '../../core/types';
import type { Workspace } from '../../core/workspace';
import { languageCounts, listWorkflows, walkFiles } from '../shared';
import type { Ecosystem, EcosystemDetection, FixStrategy, ProjectAnalysis, StepPlan } from '../types';

export const SUPPORTED_JDKS = [8, 11, 17, 21] as const;
export const DEFAULT_JDK = 17;

export function mavenRuntimeFor(jdk: number, source: string, warnings: string[] = []): RuntimeSelection {
  return {
    family: 'java',
    version: String(jdk),
    image: `maven:3.9-eclipse-temurin-${jdk}`,
    label: `JDK ${jdk} + Maven 3.9`,
    major: jdk,
    source,
    warnings,
  };
}

/** Map a declared Java level ("1.8", "11", "17") to the smallest approved JDK that can compile it. */
export function jdkFor(level: string): number | null {
  const n = Number(level.replace(/^1\./, ''));
  if (!Number.isInteger(n) || n < 5 || n > 40) return null;
  if (n <= 8) return 8;
  return SUPPORTED_JDKS.find((j) => j >= n) ?? 21;
}

export interface PomInfo {
  groupId: string | null;
  artifactId: string | null;
  javaLevel: { source: string; value: string } | null;
  modules: string[];
  dependencies: { groupId: string; artifactId: string; version: string | null }[];
  httpRepos: string[];
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(xml)?.[1] ?? null;

/** Regex-level pom reader: enough for detection and targeted edits; never evaluates the pom. */
export function parsePom(xml: string): PomInfo {
  const noComments = xml.replace(/<!--[\s\S]*?-->/g, '');
  const header = noComments.replace(
    /<(dependencies|build|dependencyManagement|profiles|repositories|pluginRepositories|parent)>[\s\S]*?<\/\1>/g,
    '',
  );
  const level =
    (['maven.compiler.release', 'maven.compiler.source', 'java.version', 'maven.compiler.target'] as const)
      .map((n) => [n, tag(noComments, n)] as const)
      .find(([, v]) => v && !v.startsWith('${')) ??
    (['release', 'source', 'target'] as const)
      .map(
        (n) =>
          [
            `compiler-plugin ${n}`,
            tag(
              /<artifactId>maven-compiler-plugin<\/artifactId>[\s\S]*?<\/plugin>/.exec(noComments)?.[0] ?? '',
              n,
            ),
          ] as const,
      )
      .find(([, v]) => v && !v.startsWith('${'));
  const deps = [
    ...noComments
      .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
      .matchAll(/<dependency>([\s\S]*?)<\/dependency>/g),
  ].map((m) => ({
    groupId: tag(m[1]!, 'groupId') ?? '',
    artifactId: tag(m[1]!, 'artifactId') ?? '',
    version: tag(m[1]!, 'version'),
  }));
  return {
    groupId: tag(header, 'groupId'),
    artifactId: tag(header, 'artifactId'),
    javaLevel: level && level[1] ? { source: level[0], value: level[1] } : null,
    modules: [...noComments.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]!),
    dependencies: deps.filter((d) => d.groupId && d.artifactId),
    httpRepos: [...noComments.matchAll(/<url>\s*(http:\/\/[^<\s]+)\s*<\/url>/g)].map((m) => m[1]!),
  };
}

export function selectMavenRuntime(jdkFile: string | null, pom: PomInfo | null): RuntimeSelection {
  const warnings: string[] = [];
  const cands: [string, string | null][] = [
    ['.java-version', jdkFile],
    [pom?.javaLevel?.source ?? 'pom.xml', pom?.javaLevel?.value ?? null],
  ];
  for (const [source, v] of cands) {
    if (!v) continue;
    const jdk = jdkFor(v.trim());
    if (jdk === null) {
      warnings.push(`Ignoring unrecognised Java level "${v}" in ${source}.`);
      continue;
    }
    return mavenRuntimeFor(jdk, source, warnings);
  }
  return mavenRuntimeFor(DEFAULT_JDK, `default (JDK ${DEFAULT_JDK})`, warnings);
}

export function diagnoseMaven(result: Pick<StepResult, 'step' | 'status' | 'logTail' | 'command'>): Issue[] {
  const log = result.logTail;
  const out: Issue[] = [];
  const add = (
    kind: IssueKind,
    fp: string,
    title: string,
    evidence: string,
    data: Record<string, string> = {},
    file?: string,
  ) => {
    if (!out.some((o) => o.fingerprint === fp))
      out.push({
        kind,
        fingerprint: fp,
        step: result.step,
        severity: 'error',
        title,
        evidence: evidence.slice(0, 500),
        data,
        diagnostic: { category: kind, message: title, command: result.command, ...(file ? { file } : {}) },
      });
  };
  if (result.status === 'timeout') {
    add('timeout', `timeout:${result.step}`, `The ${result.step} step timed out`, 'timeout');
    return out;
  }
  const first = (re: RegExp) => (log.split(/\r?\n/).find((l) => re.test(l)) ?? '').trim();
  if (/Blocked mirror for repositories|maven-default-http-blocker/.test(log))
    add(
      'missing-version',
      'http-repository-blocked',
      'Maven blocks a plain-HTTP repository',
      first(/Blocked mirror|http-blocker/),
      { blocked: 'http' },
    );
  for (const m of log.matchAll(
    /(?:Could not find artifact|Failure to find|Could not transfer artifact|The POM for) ([\w.-]+):([\w.-]+):(?:[\w.-]+:)?([\w.${}-]+)/g,
  ))
    if (!/http-blocker/.test(m[0]))
      add(
        'missing-version',
        `missing-version:${m[1]}:${m[2]}`,
        `Artifact ${m[1]}:${m[2]}:${m[3]} cannot be resolved`,
        m[0],
        { groupId: m[1]!, artifactId: m[2]!, version: m[3]! },
      );
  const rel =
    /invalid (?:target|source) release: (\d+)|release version (\d+) not supported|Unsupported class file major version|error: (?:invalid|release version) (\d+)/i.exec(
      log,
    );
  if (rel)
    add(
      'toolchain-mismatch',
      'toolchain-mismatch',
      `The build needs a newer JDK (${rel[1] ?? rel[2] ?? rel[3] ?? 'unknown'})`,
      rel[0],
      { required: rel[1] ?? rel[2] ?? rel[3] ?? '' },
    );
  const old = /(?:Source|Target) option (\d+) is no longer supported\. Use (\d+) or later/.exec(log);
  if (old)
    add(
      'toolchain-mismatch',
      'toolchain-mismatch:old-level',
      `Java level ${old[1]} is no longer supported by this JDK`,
      old[0],
      { required: '8', downgrade: 'true' },
    );
  const ce = /\[ERROR\] [^\n]*?([\w./-]+\.java):\[(\d+),(\d+)\] ([^\n]+)/.exec(log);
  const file = ce?.[1]?.replace(/^\/?workspace\//, '');
  if (out.length === 0 && (ce || /COMPILATION ERROR/.test(log)))
    add(
      'compile-error',
      `compile-error:${file ?? 'unknown'}`,
      `Java compilation failed${file ? ` in ${file}` : ''}`,
      ce?.[0] ?? first(/COMPILATION ERROR/),
      { file: file ?? '' },
      file,
    );
  if (out.length === 0 && /There are test failures|Tests run:.*(?:Failures|Errors): [1-9]/.test(log))
    add('test-failure', 'test-failure', 'Maven tests failed', first(/Tests run:|test failures/));
  if (
    out.length === 0 &&
    /Connection (?:refused|reset)|Connect timed out|UnknownHostException|Temporary failure in name resolution/i.test(
      log,
    )
  )
    add(
      'network',
      'network',
      'Network error while resolving artifacts',
      first(/Connect|Unknown|resolution/i),
    );
  if (out.length === 0)
    add(
      result.step === 'test' ? 'test-failure' : result.step === 'build' ? 'build-failure' : 'unknown',
      `${result.step}-failure`,
      `mvn ${result.step} failed`,
      first(/\[ERROR\]/),
    );
  return out;
}

export function upgradeHttpRepos(pom: string): string | null {
  const next = pom.replace(
    /(<url>\s*)http:\/\/(?!localhost|127\.0\.0\.1)([^<\s]+)(\s*<\/url>)/g,
    '$1https://$2$3',
  );
  return next === pom ? null : next;
}

export function setDependencyVersion(
  pom: string,
  groupId: string,
  artifactId: string,
  version: string,
): string | null {
  const re = new RegExp(
    `(<dependency>\\s*<groupId>\\s*${groupId.replace(/\./g, '\\.')}\\s*</groupId>\\s*<artifactId>\\s*${artifactId.replace(/[.-]/g, '\\$&')}\\s*</artifactId>\\s*<version>\\s*)[^<$]+?(\\s*</version>)`,
  );
  return re.test(pom) ? pom.replace(re, `$1${version}$2`) : null;
}

const mavenStrategies: FixStrategy[] = [
  {
    id: 'maven-https-repositories',
    handles: ['missing-version'],
    invasiveness: 1,
    async propose(issue, ctx) {
      if (issue.data?.blocked !== 'http') return [];
      const text = await ctx.ws.current('pom.xml');
      const next = text && upgradeHttpRepos(text);
      if (!next) return [];
      return [
        {
          strategyId: 'maven-https-repositories',
          title: 'Use HTTPS for repository URLs in pom.xml',
          rationale:
            'Maven 3.8.1+ blocks plain-HTTP repositories (CVE-2021-26291). Most hosts serve the same content over HTTPS; verification confirms the artifacts resolve.',
          edits: [{ path: 'pom.xml', content: next }],
          kind: 'runtime',
        },
      ];
    },
  },
  {
    id: 'maven-pin-jdk',
    handles: ['toolchain-mismatch'],
    invasiveness: 2,
    async propose(issue, ctx) {
      const cur = Number(ctx.runtime.version);
      const need = issue.data?.downgrade ? 8 : (jdkFor(issue.data?.required ?? '') ?? null);
      if (need === null || need === cur) return [];
      return [
        {
          strategyId: 'maven-pin-jdk',
          title: `Use JDK ${need} via .java-version`,
          rationale: `${issue.title}. ".java-version" selects the JDK ${need} image for installs, builds and tests (was ${cur}).`,
          edits: [{ path: '.java-version', content: `${need}\n` }],
          kind: 'runtime',
        },
      ];
    },
  },
  {
    id: 'maven-repin-dependency',
    handles: ['missing-version'],
    invasiveness: 3,
    async propose(issue, ctx) {
      const { groupId, artifactId, version } = issue.data ?? {};
      if (!groupId || !artifactId || !version || issue.data?.blocked) return [];
      const p = await ctx.registry.packument(`${groupId}:${artifactId}`);
      if (!p) {
        ctx.log(`${groupId}:${artifactId} was not found on Maven Central; not guessing a replacement.`);
        return [];
      }
      if (p.versions.includes(version)) return [];
      const pick = pickEraVersion(p, ctx.commitDate);
      const text = await ctx.ws.current('pom.xml');
      const next = pick && text ? setDependencyVersion(text, groupId, artifactId, pick.version) : null;
      if (!pick || !next || next === text) return [];
      const edit: FileEdit = { path: 'pom.xml', content: next };
      return [
        {
          strategyId: 'maven-repin-dependency',
          title: `Re-pin ${groupId}:${artifactId} to ${pick.version}`,
          rationale: `${version} is not on Maven Central. ${pick.version} is the ${pick.basis === 'era' ? "newest release before the repository's last commit" : 'newest release'}.`,
          edits: [edit],
          kind: 'runtime',
        },
      ];
    },
  },
];

const MVN = ['mvn', '-B', '-ntp', '-Dmaven.repo.local=/cache/m2'];
const FINGERPRINT = [
  'pom.xml',
  '.java-version',
  '.mvn/maven.config',
  '.mvn/wrapper/maven-wrapper.properties',
];

export async function detectMaven(ws: Workspace): Promise<EcosystemDetection | null> {
  if (!(await ws.exists('pom.xml'))) return null;
  const evidence = ['pom.xml'];
  let confidence = 0.9;
  for (const f of ['mvnw', '.mvn/wrapper/maven-wrapper.properties'])
    if (await ws.exists(f)) {
      evidence.push(f);
      confidence = 0.95;
    }
  return { confidence, evidence };
}

export const mavenEcosystem: Ecosystem = {
  id: 'maven',
  displayName: 'Java / Maven',
  language: 'Java',
  family: 'java',
  supportsCiModernize: false,
  async detect(ws) {
    return (await detectMaven(ws)) !== null;
  },
  detection: detectMaven,
  sandboxEnv: () => ({ MAVEN_OPTS: '-Xmx1g' }),

  async analyze(ws): Promise<ProjectAnalysis> {
    const pom = parsePom((await ws.current('pom.xml')) ?? '');
    const files = await walkFiles(ws);
    const tests = files.some((f) => /src\/test\/java\/.+\.java$/.test(f));
    const warnings: string[] = [];
    if (await ws.exists('mvnw'))
      warnings.push('A Maven wrapper exists; RepoRevive uses the sandbox Maven 3.9 image instead.');
    if (pom.httpRepos.length)
      warnings.push(`${pom.httpRepos.length} plain-HTTP repository URL(s) in pom.xml.`);
    const details: Record<string, string> = {};
    if (pom.javaLevel) details['Java level'] = `${pom.javaLevel.value} (${pom.javaLevel.source})`;
    if (pom.modules.length) details['Modules'] = pom.modules.join(', ');
    return {
      ecosystem: 'maven',
      packageManager: 'maven',
      projectName: pom.artifactId,
      description: null,
      dependencies: pom.dependencies.map((d) => ({
        name: `${d.groupId}:${d.artifactId}`,
        range: d.version ?? '',
        section: 'dependencies' as const,
      })),
      scripts: {},
      lockfiles: [],
      lockfileVersion: null,
      runtimeDeclarations: pom.javaLevel ? [pom.javaLevel] : [],
      hasBuild: true,
      hasTests: tests,
      testFramework: tests
        ? pom.dependencies.some((d) => d.artifactId.includes('junit'))
          ? 'JUnit'
          : 'Maven Surefire'
        : null,
      frameworks: pom.dependencies.some((d) => d.groupId.startsWith('org.springframework')) ? ['Spring'] : [],
      languages: languageCounts(files, ['java', 'kt', 'xml']),
      fileCount: files.length,
      workflows: await listWorkflows(ws),
      isMonorepo: pom.modules.length > 0,
      details,
      warnings,
    };
  },

  async selectRuntime(ws) {
    const jdkFile = (await ws.current('.java-version'))?.trim() || null;
    const text = await ws.current('pom.xml');
    return selectMavenRuntime(jdkFile, text ? parsePom(text) : null);
  },

  async plan(ws, _rt, timeouts: Record<StepName, number>): Promise<StepPlan[]> {
    const files = await walkFiles(ws);
    return [
      {
        step: 'install',
        command: [...MVN, '-DskipTests', 'dependency:go-offline'],
        network: 'bridge',
        timeoutMs: timeouts.install,
      },
      {
        step: 'build',
        command: [...MVN, '-o', '-DskipTests', 'test-compile'],
        network: 'none',
        timeoutMs: timeouts.build,
      },
      files.some((f) => /src\/test\/java\/.+\.java$/.test(f))
        ? { step: 'test', command: [...MVN, '-o', 'test'], network: 'none', timeoutMs: timeouts.test }
        : { step: 'test', command: null, skipReason: 'no-test-suite', network: 'none', timeoutMs: 0 },
    ];
  },

  async installFingerprint(ws, runtime) {
    const h = createHash('sha256').update(runtime.image);
    for (const f of FINGERPRINT) h.update(`\0${f}\0${(await ws.current(f).catch(() => null)) ?? '<none>'}`);
    return h.digest('hex');
  },
  async diagnose(result) {
    return diagnoseMaven(result);
  },
  async staticIssues() {
    return [];
  },
  warningsFromLogs: () => [],
  async lockfileRegeneration() {
    return null; // Maven has no lockfile.
  },
  strategies: mavenStrategies,
};
