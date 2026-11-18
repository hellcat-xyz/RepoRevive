import { createHash } from 'node:crypto';
import type { Issue, RuntimeSelection, StepName } from '../../core/types';
import type { Workspace } from '../../core/workspace';
import { languageCounts, listWorkflows, walkFiles } from '../shared';
import type { Ecosystem, EcosystemDetection, ProjectAnalysis, StepPlan } from '../types';
import { findBrokenReferences, MAX_BROKEN_REFERENCES } from './references';
import { staticStrategies } from './strategies';

/** Static sites need no toolchain. This image is never started: the plan has no commands. */
const NO_RUNTIME: RuntimeSelection = {
  family: 'node',
  version: '22',
  image: 'node:22',
  label: 'No runtime needed (static site)',
  major: 22,
  source: 'static site',
  warnings: [],
};

export async function detectStaticSite(ws: Workspace): Promise<EcosystemDetection | null> {
  if (await ws.exists('index.html')) return { confidence: 0.5, evidence: ['index.html'] };
  const html = (await ws.list('').catch(() => [])).filter(
    (e) => e.type === 'file' && /\.html?$/i.test(e.name),
  );
  return html.length ? { confidence: 0.4, evidence: html.slice(0, 3).map((e) => e.name) } : null;
}

async function pageTitle(ws: Workspace): Promise<string | null> {
  const text = await ws.read('index.html', 200_000).catch(() => null);
  const m = text ? /<title[^>]*>([^<]{1,120})<\/title>/i.exec(text) : null;
  return m ? m[1]!.trim() || null : null;
}

async function analyzeStaticSite(ws: Workspace): Promise<ProjectAnalysis> {
  const files = await walkFiles(ws);
  const count = (re: RegExp) => files.filter((f) => re.test(f)).length;
  return {
    ecosystem: 'static',
    packageManager: 'none',
    projectName: await pageTitle(ws),
    description: null,
    dependencies: [],
    scripts: {},
    lockfiles: [],
    lockfileVersion: null,
    runtimeDeclarations: [],
    hasBuild: false,
    hasTests: false,
    testFramework: null,
    frameworks: [],
    languages: languageCounts(files, ['html', 'htm', 'css', 'js', 'mjs', 'ts', 'json', 'svg']),
    fileCount: files.length,
    workflows: await listWorkflows(ws),
    isMonorepo: false,
    details: {
      Pages: String(count(/\.html?$/i)),
      Stylesheets: String(count(/\.css$/i)),
      Scripts: String(count(/\.m?js$/i)),
    },
    warnings: [
      'Static site: nothing is installed, built or run. RepoRevive only checks that local file references in HTML and CSS resolve.',
    ],
  };
}

export const staticEcosystem: Ecosystem = {
  id: 'static',
  displayName: 'Static site (HTML/CSS/JS)',
  language: 'HTML',
  family: 'node',
  supportsCiModernize: false,
  fallback: true,
  verification: 'static',

  detect: async (ws) => (await detectStaticSite(ws)) !== null,
  detection: detectStaticSite,
  sandboxEnv: () => ({}),
  analyze: analyzeStaticSite,
  selectRuntime: async () => ({ ...NO_RUNTIME }),

  async plan(_ws, _runtime, timeouts: Record<StepName, number>): Promise<StepPlan[]> {
    void timeouts;
    return (['install', 'build', 'test'] as const).map((step) => ({
      step,
      command: null,
      skipReason: 'not-applicable' as const,
      network: 'none' as const,
      timeoutMs: 0,
    }));
  },

  async installFingerprint(_ws, runtime) {
    return createHash('sha256').update(runtime.image).digest('hex');
  },

  async diagnose() {
    return [];
  },

  /** The diagnoser: broken local references found by reading HTML and CSS. */
  async staticIssues(ws): Promise<Issue[]> {
    const broken = await findBrokenReferences(ws);
    return broken.map((b) => ({
      kind: 'broken-reference' as const,
      fingerprint: `broken-reference:${b.file}:${b.ref}`,
      step: 'static' as const,
      severity: b.tag === 'a' ? ('warning' as const) : ('error' as const),
      title: `${b.file} references "${b.ref}", which does not exist`,
      evidence:
        `${b.file}: <${b.tag}> ${b.attr}="${b.ref}" resolves to "${b.target || '(root)'}".` +
        (b.suggestion ? ` An existing file matches when letter case is ignored: "${b.suggestion}".` : '') +
        (broken.length >= MAX_BROKEN_REFERENCES
          ? ` (Only the first ${MAX_BROKEN_REFERENCES} are listed.)`
          : ''),
      data: {
        file: b.file,
        ref: b.ref,
        target: b.target,
        ...(b.suggestion ? { suggestion: b.suggestion } : {}),
      },
      diagnostic: {
        category: 'broken-reference',
        message: `${b.attr}="${b.ref}" does not resolve`,
        file: b.file,
      },
    }));
  },

  warningsFromLogs: () => [],
  lockfileRegeneration: async () => null,
  strategies: staticStrategies,
};
