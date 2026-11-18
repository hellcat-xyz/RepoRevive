import {
  COMPANION_DIRS,
  DEFAULT_MAX_SUBPROJECTS,
  isOrchestratorRoot,
  isSkippedDir,
  limitProjects,
  MAX_FOLDERS_EXAMINED,
  MAX_SEARCH_DEPTH,
} from '../core/projects';
import { Workspace } from '../core/workspace';
import { npmEcosystem } from './npm';
import { isPlaceholderTest, readManifest, scriptsOf } from './npm/manifest';
import { goEcosystem } from './go';
import { mavenEcosystem } from './maven';
import { pythonEcosystem } from './python';
import { rustEcosystem } from './rust';
import { staticEcosystem } from './static';
import type { Ecosystem, EcosystemDetection } from './types';

/**
 * Registered ecosystems. Order is the tie-break precedence when confidences are equal.
 * Add new languages/package managers here.
 */
export const ECOSYSTEMS: Ecosystem[] = [
  npmEcosystem,
  pythonEcosystem,
  rustEcosystem,
  goEcosystem,
  mavenEcosystem,
  // Fallback: lowest precedence, only wins when nothing with a manifest matches.
  staticEcosystem,
];

export interface RankedDetection {
  ecosystem: Ecosystem;
  detection: EcosystemDetection;
}

export interface DetectionResult {
  selected: RankedDetection | null;
  /** All ecosystems that matched, best first. */
  candidates: RankedDetection[];
  /** True when a runner-up is strong and close to the winner; callers must surface this. */
  ambiguous: boolean;
}

export const AMBIGUITY_MIN_CONFIDENCE = 0.6;
export const AMBIGUITY_MARGIN = 0.15;

/** Pure ranking: confidence descending, registry order for ties. */
export function rankDetections(
  matches: RankedDetection[],
  order: readonly Ecosystem[] = ECOSYSTEMS,
): DetectionResult {
  const idx = (e: Ecosystem) => {
    const i = order.findIndex((o) => o.id === e.id);
    return i === -1 ? order.length : i;
  };
  const candidates = [...matches].sort(
    (a, b) => b.detection.confidence - a.detection.confidence || idx(a.ecosystem) - idx(b.ecosystem),
  );
  const [first, second] = candidates;
  const ambiguous =
    !!first &&
    !!second &&
    second.detection.confidence >= AMBIGUITY_MIN_CONFIDENCE &&
    first.detection.confidence - second.detection.confidence <= AMBIGUITY_MARGIN;
  return { selected: first ?? null, candidates, ambiguous };
}

export async function detectEcosystems(
  ws: Workspace,
  ecosystems: readonly Ecosystem[] = ECOSYSTEMS,
): Promise<DetectionResult> {
  const matches: RankedDetection[] = [];
  for (const e of ecosystems) {
    const detection = await e.detection(ws);
    if (detection && detection.confidence > 0) matches.push({ ecosystem: e, detection });
  }
  return rankDetections(matches, ecosystems);
}

export async function detectEcosystem(
  ws: Workspace,
  ecosystems: readonly Ecosystem[] = ECOSYSTEMS,
): Promise<Ecosystem | null> {
  return (await detectEcosystems(ws, ecosystems)).selected?.ecosystem ?? null;
}

/** Ecosystems that are fully implemented and may be advertised in the UI. */
export const SUPPORTED_ECOSYSTEM_IDS = ECOSYSTEMS.map((e) => e.id);

// ---------------------------------------------------------------------------------------------
// Multi-project discovery (MERN and other layouts with projects in sub-folders)
// ---------------------------------------------------------------------------------------------

export interface DiscoveredProject {
  /** Folder relative to the repository root; "" for the root project. */
  folder: string;
  ws: Workspace;
  ecosystem: Ecosystem;
  detection: DetectionResult;
}

export interface DiscoveryResult {
  projects: DiscoveredProject[];
  /** Projects found but not run (cap), with the reason. */
  notRun: { folder: string; ecosystem: string; reason: string }[];
  warnings: string[];
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

async function rootIsOrchestrator(ws: Workspace): Promise<boolean> {
  const m = await readManifest(ws);
  if (!m) return false;
  const scripts = scriptsOf(m.json);
  let hasLockfile = false;
  for (const l of LOCKFILES) if (await ws.exists(l)) hasLockfile = true;
  return isOrchestratorRoot({
    hasWorkspaces: m.json.workspaces !== undefined,
    hasLockfile,
    hasBuildScript: !!scripts.build?.trim(),
    hasRealTestScript: !isPlaceholderTest(scripts.test),
  });
}

async function scanFolders(
  root: Workspace,
  ecosystems: readonly Ecosystem[],
  companionsOnly: boolean,
  warnings: string[],
): Promise<DiscoveredProject[]> {
  const found: DiscoveredProject[] = [];
  let examined = 0;
  const visit = async (folder: string, level: number): Promise<void> => {
    for (const entry of await root.list(folder)) {
      if (entry.type !== 'dir' || isSkippedDir(entry.name)) continue;
      if (companionsOnly && !(level === 1 && COMPANION_DIRS.has(entry.name.toLowerCase()))) continue;
      if (++examined > MAX_FOLDERS_EXAMINED) return;
      const rel = folder === '' ? entry.name : `${folder}/${entry.name}`;
      let sub: Workspace;
      try {
        sub = await Workspace.openSub(root, rel);
      } catch {
        continue;
      }
      let detection: DetectionResult;
      try {
        // Fallback ecosystems (static sites) only count in conventional folders, never in public/ or docs/.
        const eligible = COMPANION_DIRS.has(entry.name.toLowerCase())
          ? ecosystems
          : ecosystems.filter((e) => !e.fallback);
        detection = await detectEcosystems(sub, eligible);
      } catch (err) {
        warnings.push(`Could not inspect ${rel}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (detection.selected) {
        found.push({ folder: rel, ws: sub, ecosystem: detection.selected.ecosystem, detection });
      } else if (level < MAX_SEARCH_DEPTH && !companionsOnly) {
        await visit(rel, level + 1);
      }
    }
  };
  await visit('', 1);
  return found;
}

/**
 * Decide which projects a repository contains.
 * - Root is a normal project: that project, plus conventional companions (client/, server/, ...).
 * - Root is an npm orchestrator or has no project: every project found up to depth 2.
 * Read-only: files are only read through Workspace; nothing from the repository is executed.
 */
export async function discoverProjects(
  root: Workspace,
  ecosystems: readonly Ecosystem[] = ECOSYSTEMS,
  opts: { maxProjects?: number } = {},
): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const rootDetection = await detectEcosystems(root, ecosystems);
  const rootSelected = rootDetection.selected;
  const orchestrator = rootSelected?.ecosystem.id === 'npm' && (await rootIsOrchestrator(root));

  let all: DiscoveredProject[] = [];
  const rootProject: DiscoveredProject | null =
    rootSelected && !orchestrator
      ? { folder: '', ws: root, ecosystem: rootSelected.ecosystem, detection: rootDetection }
      : null;

  const found = await scanFolders(root, ecosystems, rootProject !== null, warnings);
  if (rootProject) {
    all = [rootProject, ...found];
  } else if (found.length > 0) {
    all = found;
    if (orchestrator)
      warnings.push(
        'The root package.json only orchestrates other folders; verifying each sub-project separately.',
      );
  } else if (rootSelected) {
    // Orchestrator-looking root with nothing else to run: verify the root itself.
    all = [{ folder: '', ws: root, ecosystem: rootSelected.ecosystem, detection: rootDetection }];
  }

  const { kept, dropped } = limitProjects(all, opts.maxProjects ?? DEFAULT_MAX_SUBPROJECTS);
  const notRun = dropped.map((d) => ({
    folder: d.folder,
    ecosystem: d.ecosystem.id,
    reason: `Not run: more than ${kept.length} projects found (MAX_SUBPROJECTS).`,
  }));
  if (kept.length > 1)
    warnings.push(
      `Multi-project repository: ${kept.map((p) => p.folder || '(root)').join(', ')}. Each project is verified on its own.`,
    );
  return { projects: kept, notRun, warnings };
}
