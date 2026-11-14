import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  OutputListener,
  PackageRegistry,
  Packument,
  RunResult,
  RunSpec,
  Sandbox,
} from '@/engine/core/ports';
import type { AttemptRecord } from '@/engine/core/types';
import type { JobReporter, JobUpdate } from '@/engine/pipeline';

export interface WorldView {
  label: string;
  command: string[];
  major: number;
  network: RunSpec['network'];
  read(rel: string): string | null;
  pkg(): Record<string, Record<string, string> | string | undefined>;
  deps(): Record<string, string>;
}

export interface WorldResult {
  exitCode: number;
  output: string;
  timedOut?: boolean;
  /** Files the command writes (e.g. a regenerated lockfile). */
  writes?: Record<string, string>;
}

export type World = (v: WorldView) => WorldResult;

/**
 * A scripted stand-in for Docker. It decides each command's outcome from the current workspace
 * files (a "world model"), so pipeline tests exercise real diagnosis, strategies, verification,
 * and rollback without containers or network.
 */
export class FakeSandbox implements Sandbox {
  readonly runs: { label: string; image: string; command: string[]; network: string }[] = [];

  constructor(private readonly world: World) {}

  async ensureImage(): Promise<void> {}

  async run(spec: RunSpec, onLine?: OutputListener): Promise<RunResult> {
    this.runs.push({ label: spec.label, image: spec.image, command: spec.command, network: spec.network });
    const files = new Map<string, string | null>();
    const read = (rel: string) => {
      if (!files.has(rel)) {
        try {
          files.set(rel, readFileSync(path.join(spec.workdir, rel), 'utf8'));
        } catch {
          files.set(rel, null);
        }
      }
      return files.get(rel)!;
    };
    const pkg = () =>
      JSON.parse(read('package.json') ?? '{}') as Record<string, Record<string, string> | string | undefined>;
    const view: WorldView = {
      label: spec.label,
      command: spec.command,
      major: Number(spec.image.split(':')[1]),
      network: spec.network,
      read,
      pkg,
      deps: () => {
        const p = pkg();
        return {
          ...((p.dependencies as Record<string, string>) ?? {}),
          ...((p.devDependencies as Record<string, string>) ?? {}),
        };
      },
    };
    const res = this.world(view);
    for (const [rel, content] of Object.entries(res.writes ?? {}))
      await fs.writeFile(path.join(spec.workdir, rel), content);
    for (const line of res.output.split('\n')) if (line) onLine?.(line, 'stdout');
    return {
      exitCode: res.timedOut ? 124 : res.exitCode,
      timedOut: !!res.timedOut,
      durationMs: 10,
      output: res.output,
    };
  }

  async removeDir(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export class FakeRegistry implements PackageRegistry {
  constructor(private readonly packuments: Record<string, Packument>) {}
  async packument(name: string): Promise<Packument | null> {
    return this.packuments[name] ?? null;
  }
}

export function simplePackument(name: string, versions: [string, string][], bins?: string[]): Packument {
  return {
    name,
    versions: versions.map(([v]) => v),
    time: Object.fromEntries(versions),
    distTags: { latest: versions[versions.length - 1]![0] },
    bins: bins ? Object.fromEntries(versions.map(([v]) => [v, bins])) : undefined,
  };
}

export class MemoryReporter implements JobReporter {
  readonly updates: JobUpdate[] = [];
  readonly attempts: AttemptRecord[] = [];
  async update(f: JobUpdate) {
    this.updates.push(f);
  }
  async saveAttempt(a: AttemptRecord) {
    this.attempts.push(a);
  }
  get statuses() {
    return this.updates.filter((u) => u.status).map((u) => u.status);
  }
}

export async function makeRepo(
  files: Record<string, string>,
): Promise<{ jobDir: string; repoDir: string; cleanup: () => Promise<void> }> {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-job-'));
  const repoDir = path.join(jobDir, 'repo');
  await fs.mkdir(repoDir);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
    await fs.writeFile(path.join(repoDir, rel), content);
  }
  return { jobDir, repoDir, cleanup: () => fs.rm(jobDir, { recursive: true, force: true }) };
}

export async function readTree(
  root: string,
  skip = new Set(['node_modules']),
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(rel: string) {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else out[r] = await fs.readFile(path.join(root, r), 'utf8');
    }
  }
  await walk('');
  return out;
}

export function fakeClock() {
  let t = Date.parse('2025-01-01T00:00:00Z');
  return { now: () => (t += 1000) };
}
