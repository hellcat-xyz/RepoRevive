import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ResurrectionError } from '@/engine/core/errors';
import type { OutputListener, RunResult, RunSpec, Sandbox } from '@/engine/core/ports';

export interface DockerSandboxOptions {
  jobId: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  dockerBin?: string;
  /** Max bytes of output kept for diagnosis. */
  maxOutputBytes?: number;
}

const IMAGE_RE = /^node:\d{1,2}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Ring buffer of the last N bytes of output. */
class OutputTail {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(s: string) {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
  }
  toString() {
    const all = this.chunks.join('');
    return all.length > this.max ? all.slice(all.length - this.max) : all;
  }
}

function hostUser(): string {
  // On Linux, match the host uid so the worker can edit files the container created.
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    return `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`;
  }
  return '1000:1000'; // the `node` user in official images
}

/**
 * Runs each command in a fresh, locked-down container:
 * no capabilities, no privilege escalation, read-only root fs, non-root user, resource limits,
 * network only when requested, workspace bind-mounted at /workspace.
 */
export class DockerSandbox implements Sandbox {
  private readonly docker: string;
  private readonly pulled = new Set<string>();
  private counter = 0;

  constructor(private readonly opts: DockerSandboxOptions) {
    this.docker = opts.dockerBin ?? 'docker';
  }

  static async assertAvailable(dockerBin = 'docker'): Promise<void> {
    const code = await new Promise<number>((resolve) => {
      const p = spawn(dockerBin, ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
      p.on('error', () => resolve(-1));
      p.on('close', (c) => resolve(c ?? -1));
    });
    if (code !== 0) {
      throw new ResurrectionError(
        'DOCKER_UNAVAILABLE',
        'Docker is not available to the worker. Start Docker and try again.',
      );
    }
  }

  private exec(args: string[], onLine?: OutputListener, timeoutMs?: number, onTimeout?: () => void) {
    return new Promise<{ code: number; output: string; timedOut: boolean }>((resolve, reject) => {
      const tail = new OutputTail(this.opts.maxOutputBytes ?? 256 * 1024);
      const child = spawn(this.docker, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            onTimeout?.();
            setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
          }, timeoutMs)
        : null;
      const wire = (stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr') => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          tail.push(chunk);
          if (!onLine) return;
          buf += chunk;
          const parts = buf.split(/\r?\n|\r/);
          buf = parts.pop() ?? '';
          for (const line of parts) if (line.trim()) onLine(line, name);
          if (buf.length > 8192) {
            onLine(buf, name);
            buf = '';
          }
        });
        stream.on('end', () => {
          if (onLine && buf.trim()) onLine(buf, name);
        });
      };
      wire(child.stdout!, 'stdout');
      wire(child.stderr!, 'stderr');
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new ResurrectionError('DOCKER_UNAVAILABLE', `Failed to start docker: ${err.message}`, err));
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, output: tail.toString(), timedOut });
      });
    });
  }

  async ensureImage(image: string, onLine?: OutputListener): Promise<void> {
    if (!IMAGE_RE.test(image)) throw new ResurrectionError('INTERNAL', `Refusing unexpected image ${image}`);
    if (this.pulled.has(image)) return;
    const inspect = await this.exec(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (inspect.code !== 0) {
      onLine?.(`Pulling ${image}…`, 'stdout');
      const pull = await this.exec(['pull', '--quiet', image], onLine, 15 * 60_000);
      if (pull.code !== 0)
        throw new ResurrectionError('NETWORK_ERROR', `Could not pull ${image}: ${pull.output.slice(-300)}`);
    }
    this.pulled.add(image);
  }

  buildRunArgs(spec: RunSpec, name: string): string[] {
    if (!IMAGE_RE.test(spec.image))
      throw new ResurrectionError('INTERNAL', `Refusing unexpected image ${spec.image}`);
    if (!path.isAbsolute(spec.workdir))
      throw new ResurrectionError('INTERNAL', 'Sandbox workdir must be absolute');
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      `reporevive.job=${this.opts.jobId}`,
      '--user',
      hostUser(),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,size=1g',
      '--memory',
      this.opts.memory,
      '--memory-swap',
      this.opts.memory,
      '--cpus',
      this.opts.cpus,
      '--pids-limit',
      String(this.opts.pidsLimit),
      '--network',
      spec.network,
      '--ipc',
      'none',
      '-v',
      `${spec.workdir}:/workspace:rw`,
      '-w',
      '/workspace',
      '-e',
      'HOME=/tmp',
    ];
    if (spec.cacheDir) {
      args.push('-v', `${spec.cacheDir}:/cache:rw`, '-e', 'npm_config_cache=/cache/npm');
    }
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      if (!ENV_KEY_RE.test(k)) throw new ResurrectionError('INTERNAL', `Invalid env key ${k}`);
      args.push('-e', `${k}=${v}`);
    }
    args.push('--entrypoint', '', spec.image, ...spec.command);
    return args;
  }

  async run(spec: RunSpec, onLine?: OutputListener): Promise<RunResult> {
    const name = `rr-${this.opts.jobId.slice(0, 24)}-${spec.label.replace(/[^a-z0-9-]/gi, '')}-${++this.counter}-${randomBytes(3).toString('hex')}`;
    const started = Date.now();
    const res = await this.exec(this.buildRunArgs(spec, name), onLine, spec.timeoutMs, () => {
      onLine?.(`⏱ ${spec.label} exceeded ${Math.round(spec.timeoutMs / 1000)}s; killing container`, 'stderr');
      spawn(this.docker, ['kill', name], { stdio: 'ignore' }).on('error', () => undefined);
    });
    return {
      exitCode: res.timedOut ? 124 : res.code,
      timedOut: res.timedOut,
      durationMs: Date.now() - started,
      output: res.output,
    };
  }

  async removeDir(hostDir: string): Promise<void> {
    try {
      await fs.access(hostDir);
    } catch {
      return;
    }
    // Files may belong to the sandbox uid; delete them from inside a container first.
    await this.exec([
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      hostUser(),
      '--entrypoint',
      '',
      '-v',
      `${hostDir}:/target:rw`,
      'node:22',
      'sh',
      '-c',
      'rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null; true',
    ]).catch(() => undefined);
    await fs.rm(hostDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Kill leftover containers for this job (e.g. after a crash). */
  async reap(): Promise<void> {
    const ps = await this.exec(['ps', '-q', '--filter', `label=reporevive.job=${this.opts.jobId}`]);
    const ids = ps.output.split(/\s+/).filter(Boolean);
    if (ids.length) await this.exec(['rm', '-f', ...ids]);
  }
}
