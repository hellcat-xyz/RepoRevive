import { describe, expect, it } from 'vitest';
import { MemoryEventSink } from '@/engine/core/ports';
import { Workspace } from '@/engine/core/workspace';
import { detectEcosystems, ECOSYSTEMS } from '@/engine/ecosystems';
import {
  diagnoseMaven,
  jdkFor,
  mavenEcosystem,
  parsePom,
  selectMavenRuntime,
  setDependencyVersion,
  upgradeHttpRepos,
} from '@/engine/ecosystems/maven';
import { HttpMavenRegistry } from '@/engine/ecosystems/maven/registry-http';
import { ResurrectionPipeline, type PipelineConfig } from '@/engine/pipeline';
import {
  fakeClock,
  FakeRegistry,
  FakeSandbox,
  makeRepo,
  MemoryReporter,
  simplePackument,
  type World,
} from '../helpers/fake-world';

const CONFIG: PipelineConfig = {
  maxAttempts: 6,
  jobTimeoutMs: 3_600_000,
  cloneTimeoutMs: 60_000,
  timeouts: { install: 60_000, build: 60_000, test: 60_000 },
  networkForBuild: false,
};
const POM = (dep = '1.2.99', extra = '') => `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId><artifactId>app</artifactId><version>1.0</version>
  <properties><maven.compiler.source>1.8</maven.compiler.source><maven.compiler.target>1.8</maven.compiler.target></properties>
  <dependencies>
    <dependency><groupId>commons-lang</groupId><artifactId>commons-lang</artifactId><version>${dep}</version></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
  </dependencies>${extra}
</project>`;
const files = (pom: string) => ({
  'pom.xml': pom,
  'src/main/java/A.java': 'class A {}',
  'src/test/java/ATest.java': 'class ATest {}',
});
const REG = new FakeRegistry({
  'commons-lang:commons-lang': simplePackument('commons-lang:commons-lang', [
    ['2.5', '2009-04-01T00:00:00Z'],
    ['2.6', '2011-01-01T00:00:00Z'],
  ]),
});
const ok = { exitCode: 0, output: 'BUILD SUCCESS' };

async function resurrect(f: Record<string, string>, commitDate: string, world: World) {
  const repo = await makeRepo(f);
  const sandbox = new FakeSandbox(world);
  const outcome = await new ResurrectionPipeline(
    {
      sandbox,
      registry: new FakeRegistry({}),
      registries: { maven: REG },
      llm: null,
      sink: new MemoryEventSink(),
      reporter: new MemoryReporter(),
      clock: fakeClock(),
    },
    CONFIG,
  ).run({
    jobId: 'job-mvn',
    repo: { owner: 'm', name: 'mvn', url: 'https://github.com/m/mvn' },
    jobDir: repo.jobDir,
    preCloned: { commitSha: 'e'.repeat(40), commitDate },
  });
  await repo.cleanup();
  return { outcome, sandbox };
}

describe('maven', () => {
  it('parses pom metadata and maps Java levels to approved JDKs', () => {
    const p = parsePom(POM('2.6', '<modules><module>core</module></modules>'));
    expect(p).toMatchObject({
      artifactId: 'app',
      groupId: 'com.acme',
      modules: ['core'],
      javaLevel: { source: 'maven.compiler.source', value: '1.8' },
    });
    expect(p.dependencies.map((d) => `${d.groupId}:${d.artifactId}:${d.version}`)).toContain(
      'commons-lang:commons-lang:2.6',
    );
    expect([
      jdkFor('1.8'),
      jdkFor('8'),
      jdkFor('9'),
      jdkFor('11'),
      jdkFor('15'),
      jdkFor('17'),
      jdkFor('19'),
      jdkFor('abc'),
    ]).toEqual([8, 8, 11, 11, 17, 17, 21, null]);
    expect(selectMavenRuntime(null, p)).toMatchObject({
      family: 'java',
      image: 'maven:3.9-eclipse-temurin-8',
      version: '8',
    });
    expect(selectMavenRuntime('17', p).image).toBe('maven:3.9-eclipse-temurin-17');
    expect(selectMavenRuntime(null, null).image).toBe('maven:3.9-eclipse-temurin-17');
  });

  it('detects Maven and plans offline build/test after a networked resolve; Gradle is not claimed', async () => {
    const repo = await makeRepo({ ...files(POM()), mvnw: '#!/bin/sh' });
    const ws = await Workspace.open(repo.repoDir);
    const d = await detectEcosystems(ws, ECOSYSTEMS);
    expect(d.selected?.ecosystem.id).toBe('maven');
    const plan = await mavenEcosystem.plan(ws, await mavenEcosystem.selectRuntime(ws), CONFIG.timeouts);
    expect(plan.map((p) => p.network)).toEqual(['bridge', 'none', 'none']);
    expect(plan[0]!.command).toContain('dependency:go-offline');
    expect(plan[1]!.command).toContain('-o');
    expect((await mavenEcosystem.analyze(ws)).warnings.join(' ')).toMatch(/wrapper/);
    await repo.cleanup();
    const gradle = await makeRepo({ 'build.gradle': 'plugins {}' });
    expect((await detectEcosystems(await Workspace.open(gradle.repoDir), ECOSYSTEMS)).selected).toBeNull();
    await gradle.cleanup();
  });

  it('diagnoses Maven failures', () => {
    const d = (step: 'install' | 'build' | 'test', logTail: string) =>
      diagnoseMaven({ step, status: 'failed', logTail });
    expect(
      d(
        'install',
        '[ERROR] Failed to execute goal ...: Could not find artifact commons-lang:commons-lang:jar:2.6.99 in central',
      )[0],
    ).toMatchObject({
      kind: 'missing-version',
      data: { groupId: 'commons-lang', artifactId: 'commons-lang', version: '2.6.99' },
    });
    expect(
      d(
        'install',
        'Blocked mirror for repositories: [old (http://repo.example.com/m2, default, releases+snapshots)]',
      )[0],
    ).toMatchObject({ kind: 'missing-version', data: { blocked: 'http' } });
    expect(d('build', 'Fatal error compiling: error: invalid target release: 17')[0]).toMatchObject({
      kind: 'toolchain-mismatch',
      data: { required: '17' },
    });
    expect(d('build', 'error: Source option 6 is no longer supported. Use 8 or later.')[0]).toMatchObject({
      kind: 'toolchain-mismatch',
      data: { downgrade: 'true' },
    });
    expect(
      d(
        'build',
        '[ERROR] COMPILATION ERROR :\n[ERROR] /workspace/src/main/java/A.java:[3,5] cannot find symbol',
      )[0],
    ).toMatchObject({
      kind: 'compile-error',
      diagnostic: { file: 'src/main/java/A.java' },
    });
    expect(d('test', 'Tests run: 3, Failures: 1, Errors: 0\nThere are test failures.')[0]?.kind).toBe(
      'test-failure',
    );
  });

  it('edits only the matching dependency version, https repos, and ignores property versions', () => {
    expect(setDependencyVersion(POM(), 'commons-lang', 'commons-lang', '2.6')).toContain(
      '<version>2.6</version>',
    );
    expect(setDependencyVersion(POM('${lang.version}'), 'commons-lang', 'commons-lang', '2.6')).toBeNull();
    expect(upgradeHttpRepos('<url>http://repo.example.com/m2</url><url>http://localhost:8080</url>')).toBe(
      '<url>https://repo.example.com/m2</url><url>http://localhost:8080</url>',
    );
    expect(upgradeHttpRepos('<url>https://x</url>')).toBeNull();
  });

  it('Maven Central client turns search docs into a packument', async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({ response: { docs: [{ v: '2.6', timestamp: 1293840000000 }] } }),
      )) as unknown as typeof fetch;
    const reg = new HttpMavenRegistry('https://s', 1000, f);
    expect(await reg.packument('commons-lang:commons-lang')).toMatchObject({
      versions: ['2.6'],
      time: { '2.6': '2011-01-01T00:00:00.000Z' },
    });
    expect(await reg.packument('bad name:x')).toBeNull();
  });

  it('fixture: missing dependency version is re-pinned to an era release', async () => {
    const r = await resurrect(files(POM()), '2010-01-01T00:00:00Z', (v) =>
      v.label === 'install' && v.read('pom.xml')?.includes('2.6.99')
        ? {
            exitCode: 1,
            output: '[ERROR] Could not find artifact commons-lang:commons-lang:jar:1.2.99 in central',
          }
        : ok,
    );
    // The scripted log names 1.2.99 (pom has 1.2.99); registry has 2.5 as the era release.
    expect(r.outcome.workspace!.changes().length).toBeLessThanOrEqual(1);
    const r2 = await resurrect(files(POM('2.6.99')), '2010-01-01T00:00:00Z', (v) =>
      v.label === 'install' && v.read('pom.xml')?.includes('2.6.99')
        ? {
            exitCode: 1,
            output: '[ERROR] Could not find artifact commons-lang:commons-lang:jar:2.6.99 in central',
          }
        : ok,
    );
    expect(r2.outcome.health).toBe('REVIVED');
    expect(r2.outcome.workspace!.changes()).toMatchObject([{ path: 'pom.xml' }]);
    expect(r2.outcome.workspace!.changes()[0]!.after).toContain('<version>2.5</version>');
    expect(r2.sandbox.runs.every((x) => x.image === 'maven:3.9-eclipse-temurin-8')).toBe(true);
  });

  it('fixture: a JDK mismatch is fixed with .java-version and a blocked http repo with https', async () => {
    const jdk = await resurrect(files(POM('2.6')), '2022-01-01T00:00:00Z', (v) =>
      v.label === 'build' && v.read('.java-version') === null
        ? { exitCode: 1, output: 'Fatal error compiling: error: invalid target release: 17' }
        : ok,
    );
    expect(jdk.outcome.health).toBe('REVIVED');
    expect(jdk.outcome.workspace!.changes()).toMatchObject([{ path: '.java-version', after: '17\n' }]);
    const http = await resurrect(
      files(
        POM(
          '2.6',
          '<repositories><repository><id>old</id><url>http://repo.example.com/m2</url></repository></repositories>',
        ),
      ),
      '2022-01-01T00:00:00Z',
      (v) =>
        v.label === 'install' && v.read('pom.xml')?.includes('http://repo.example.com')
          ? {
              exitCode: 1,
              output: 'Blocked mirror for repositories: [old (http://repo.example.com/m2, default)]',
            }
          : ok,
    );
    expect(http.outcome.health).toBe('REVIVED');
    expect(http.outcome.workspace!.changes()[0]!.after).toContain('https://repo.example.com/m2');
  });
});
