import { describe, expect, it } from 'vitest';
import { DockerSandbox } from '@/sandbox/docker-sandbox';
import { makeRepo } from '../helpers/fake-world';

/**
 * Opt-in (REPOREVIVE_DOCKER_TESTS=1): pulls the approved runtime images and checks that each toolchain
 * starts inside the locked-down sandbox (read-only root, non-root, no network) and can write its cache.
 */
const CASES: [string, string[], string][] = [
  ['python:3.11-slim', ['python', '-c', 'import sys; print(sys.version_info[:2])'], '(3, 11)'],
  ['rust:1.85-slim', ['cargo', '--version'], 'cargo 1.85'],
  ['golang:1.22', ['go', 'version'], 'go1.22'],
  ['maven:3.9-eclipse-temurin-17', ['mvn', '-v'], 'Apache Maven 3.9'],
];

describe.runIf(process.env.REPOREVIVE_DOCKER_TESTS === '1')('ecosystem runtimes (real containers)', () => {
  for (const [image, command, expected] of CASES) {
    it(`${image} runs under the sandbox restrictions`, async () => {
      const repo = await makeRepo({});
      const cache = `${repo.jobDir}/cache`;
      const { promises: fs } = await import('node:fs');
      await fs.mkdir(cache, { recursive: true });
      const sb = new DockerSandbox({
        jobId: `itest-${image.replace(/\W/g, '')}`.slice(0, 40),
        memory: '1g',
        cpus: '1',
        pidsLimit: 256,
      });
      try {
        await sb.ensureImage(image);
        const r = await sb.run({
          image,
          command,
          workdir: repo.repoDir,
          cacheDir: cache,
          network: 'none',
          timeoutMs: 120_000,
          label: 'probe',
        });
        expect(r.exitCode).toBe(0);
        expect(r.output).toContain(expected);
      } finally {
        await sb.removeDir(repo.jobDir);
      }
    }, 600_000);
  }

  it('refuses an image outside the allow-list without starting a container', async () => {
    const sb = new DockerSandbox({ jobId: 'itest-deny', memory: '256m', cpus: '1', pidsLimit: 64 });
    await expect(sb.ensureImage('ubuntu:22.04')).rejects.toThrow(/Refusing/);
  });
});
