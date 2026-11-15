import type { Workspace } from '../../core/workspace';
import { languageCounts, listWorkflows, walkFiles } from '../shared';
import type { ProjectAnalysis } from '../types';
import { readRustProject } from './project';

const MAX_SCAN_FILES = 200;
const MAX_SCAN_BYTES = 200_000;

/** True when any Rust source declares `#[test]` or `#[cfg(test)]`, or an integration `tests/` dir exists. */
export async function hasRustTests(ws: Workspace, files: string[]): Promise<boolean> {
  if (files.some((f) => /(?:^|\/)tests\/[^/]+\.rs$/.test(f))) return true;
  for (const f of files.filter((x) => x.endsWith('.rs')).slice(0, MAX_SCAN_FILES)) {
    const text = await ws.read(f, MAX_SCAN_BYTES).catch(() => null);
    if (text && /#\[(?:cfg\(test\)|test|tokio::test)\]/.test(text)) return true;
  }
  return false;
}

export async function analyzeRustProject(ws: Workspace): Promise<ProjectAnalysis> {
  const p = await readRustProject(ws);
  const files = await walkFiles(ws);
  const tests = await hasRustTests(ws, files);
  const warnings = [...p.warnings];
  if (!p.lockfile) warnings.push('No Cargo.lock; dependency versions are resolved fresh.');
  if (p.channel && !/^1\.\d/.test(p.channel.value))
    warnings.push(
      `${p.channel.source} requests "${p.channel.value}"; only numeric stable toolchains are available.`,
    );
  const names = new Set(p.dependencies.map((d) => d.name));
  const frameworks = ['tokio', 'actix-web', 'axum', 'rocket', 'serde', 'clap', 'bevy'].filter((n) =>
    names.has(n),
  );
  const details: Record<string, string> = {};
  if (p.edition) details['Edition'] = p.edition;
  if (p.rustVersion) details['rust-version'] = p.rustVersion;
  if (p.channel) details['Toolchain'] = `${p.channel.value} (${p.channel.source})`;
  if (p.workspaceMembers.length) details['Workspace members'] = p.workspaceMembers.join(', ');
  if (p.buildScripts.length) details['Build scripts'] = p.buildScripts.join(', ');
  if (p.targets.length) details['Targets'] = p.targets.slice(0, 12).join(', ');
  if (p.hasCargoConfig) details['.cargo/config'] = 'present';
  return {
    ecosystem: 'rust',
    packageManager: 'cargo',
    projectName: p.packageName,
    description: p.description,
    dependencies: p.dependencies,
    scripts: {},
    lockfiles: p.lockfile ? ['Cargo.lock'] : [],
    lockfileVersion: null,
    runtimeDeclarations: p.channel ? [p.channel] : [],
    hasBuild: true,
    hasTests: tests,
    testFramework: tests ? 'cargo test' : null,
    frameworks,
    languages: languageCounts(files, ['rs', 'toml']),
    fileCount: files.length,
    workflows: await listWorkflows(ws),
    isMonorepo: p.workspaceMembers.length > 0 || p.manifests.length > 1,
    details,
    warnings,
  };
}
