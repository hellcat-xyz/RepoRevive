import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Workspace } from '@/engine/core/workspace';
import { discoverProjects } from '@/engine/ecosystems';
import { makeRepo } from '../helpers/fake-world';

const pkg = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', version: '1.0.0', ...extra }) + '\n';
const LOCK = '{"lockfileVersion":3}\n';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function discover(files: Record<string, string>, maxProjects?: number) {
  const repo = await makeRepo(files);
  cleanups.push(repo.cleanup);
  const ws = await Workspace.open(repo.repoDir);
  const d = await discoverProjects(ws, undefined, { maxProjects });
  return { d, folders: d.projects.map((p) => p.folder), repo };
}

describe('discoverProjects', () => {
  it('finds client and server when the root has no project (MERN layout)', async () => {
    const { folders } = await discover({
      'client/package.json': pkg({ scripts: { build: 'vite build' } }),
      'client/package-lock.json': LOCK,
      'server/package.json': pkg({ scripts: { test: 'mocha' } }),
      'README.md': '# mern',
    });
    expect(folders).toEqual(['client', 'server']);
  });

  it('treats an orchestrating root package.json as a container', async () => {
    const { d, folders } = await discover({
      'package.json': pkg({ scripts: { dev: 'concurrently "npm:server" "npm:client"' } }),
      'client/package.json': pkg(),
      'server/package.json': pkg(),
    });
    expect(folders).toEqual(['client', 'server']);
    expect(d.warnings.join(' ')).toMatch(/orchestrates/);
  });

  it('keeps a real root project and adds conventional companion folders', async () => {
    const { folders } = await discover({
      'package.json': pkg({ scripts: { start: 'node index.js' } }),
      'package-lock.json': LOCK,
      'client/package.json': pkg(),
      'docs/package.json': pkg(),
    });
    expect(folders).toEqual(['', 'client']);
  });

  it('keeps a workspaces root as a single project', async () => {
    const { folders } = await discover({
      'package.json': pkg({ workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg(),
      'client/package.json': pkg(),
    });
    expect(folders).toEqual(['', 'client']);
  });

  it('falls back to the root when an orchestrator-looking root has nothing else', async () => {
    const { folders } = await discover({ 'package.json': pkg() });
    expect(folders).toEqual(['']);
  });

  it('searches two levels deep, skips dependency folders and does not descend into projects', async () => {
    const { folders } = await discover({
      'apps/web/package.json': pkg(),
      'apps/web/inner/package.json': pkg(),
      'node_modules/dep/package.json': pkg(),
      '.hidden/package.json': pkg(),
      'a/b/c/package.json': pkg(),
    });
    expect(folders).toEqual(['apps/web']);
  });

  it('mixes ecosystems (Node client, Python API)', async () => {
    const { d } = await discover({
      'client/package.json': pkg(),
      'api/requirements.txt': 'flask\n',
    });
    expect(d.projects.map((p) => [p.folder, p.ecosystem.id])).toEqual([
      ['api', 'python'],
      ['client', 'npm'],
    ]);
  });

  it('caps the project count and reports the rest as not run', async () => {
    const { d } = await discover(
      {
        'a/package.json': pkg(),
        'b/package.json': pkg(),
        'c/package.json': pkg(),
      },
      2,
    );
    expect(d.projects.map((p) => p.folder)).toEqual(['a', 'b']);
    expect(d.notRun.map((n) => n.folder)).toEqual(['c']);
  });

  it('treats a plain static site as one static project, and ignores static-looking sub-folders', async () => {
    const { d } = await discover({ 'index.html': '<html></html>', 'script.js': '', 'pic/a.png': '' });
    expect(d.projects.map((p) => [p.folder, p.ecosystem.id])).toEqual([['', 'static']]);
    const nested = await discover({
      'client/package.json': pkg(),
      'public/index.html': '<html></html>',
      'docs/index.html': '',
    });
    expect(nested.folders).toEqual(['client']);
  });

  it('never follows a symlinked folder', async () => {
    const repo = await makeRepo({ 'real/package.json': pkg() });
    cleanups.push(repo.cleanup);
    try {
      await fs.symlink(path.join(repo.repoDir, 'real'), path.join(repo.repoDir, 'link'), 'dir');
    } catch {
      return; // symlinks need privileges on some Windows setups
    }
    const ws = await Workspace.open(repo.repoDir);
    const d = await discoverProjects(ws);
    expect(d.projects.map((p) => p.folder)).toEqual(['real']);
  });
});
