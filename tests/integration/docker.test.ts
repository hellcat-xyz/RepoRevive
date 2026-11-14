import { describe, expect, it } from 'vitest';
import { MemoryEventSink } from '@/engine/core/ports';
import { ResurrectionPipeline } from '@/engine/pipeline';
import { DockerSandbox } from '@/sandbox/docker-sandbox';
import { FakeRegistry, makeRepo, MemoryReporter } from '../helpers/fake-world';

/**
 * Opt-in: needs a running Docker daemon and network access to pull node images.
 * Run with `npm run test:docker`.
 */
describe.runIf(process.env.REPOREVIVE_DOCKER_TESTS === '1')('DockerSandbox (real containers)', () => {
  it('enforces no network, non-root user, and read-only root filesystem', async () => {
    const repo = await makeRepo({
      'probe.sh':
        'id -u; touch /etc/x 2>/dev/null && echo rootfs-writable || echo rootfs-readonly; getent hosts registry.npmjs.org >/dev/null && echo net || echo nonet\n',
    });
    const sb = new DockerSandbox({ jobId: 'itest', memory: '512m', cpus: '1', pidsLimit: 128 });
    try {
      await sb.ensureImage('node:22');
      const r = await sb.run({
        image: 'node:22',
        command: ['sh', 'probe.sh'],
        workdir: repo.repoDir,
        network: 'none',
        timeoutMs: 60_000,
        label: 'probe',
      });
      expect(r.exitCode).toBe(0);
      expect(r.output).not.toMatch(/^0$/m);
      expect(r.output).toContain('rootfs-readonly');
      expect(r.output).toContain('nonet');
    } finally {
      await sb.removeDir(repo.jobDir);
    }
  }, 300_000);

  it('kills commands that exceed their timeout', async () => {
    const repo = await makeRepo({});
    const sb = new DockerSandbox({ jobId: 'itest-timeout', memory: '256m', cpus: '1', pidsLimit: 64 });
    try {
      const r = await sb.run({
        image: 'node:22',
        command: ['sleep', '120'],
        workdir: repo.repoDir,
        network: 'none',
        timeoutMs: 3_000,
        label: 'sleep',
      });
      expect(r.timedOut).toBe(true);
    } finally {
      await sb.removeDir(repo.jobDir);
    }
  }, 120_000);

  it('runs the full pipeline on a tiny healthy project', async () => {
    const repo = await makeRepo({
      'package.json':
        JSON.stringify(
          {
            name: 'tiny',
            version: '1.0.0',
            scripts: { build: 'node -e "1"', test: 'node -e "process.exit(0)"' },
          },
          null,
          2,
        ) + '\n',
    });
    const sb = new DockerSandbox({ jobId: 'itest-pipeline', memory: '1g', cpus: '1', pidsLimit: 256 });
    try {
      const outcome = await new ResurrectionPipeline(
        {
          sandbox: sb,
          registry: new FakeRegistry({}),
          llm: null,
          sink: new MemoryEventSink(),
          reporter: new MemoryReporter(),
        },
        {
          maxAttempts: 3,
          jobTimeoutMs: 600_000,
          cloneTimeoutMs: 60_000,
          timeouts: { install: 180_000, build: 60_000, test: 60_000 },
          networkForBuild: false,
        },
      ).run({
        jobId: 'itest-pipeline',
        repo: { owner: 'x', name: 'tiny', url: 'https://github.com/x/tiny' },
        jobDir: repo.jobDir,
        preCloned: { commitSha: 'b'.repeat(40), commitDate: null },
      });
      expect(outcome.health).toBe('REVIVED');
    } finally {
      await sb.removeDir(repo.jobDir);
    }
  }, 600_000);
});
