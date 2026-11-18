/**
 * Ecosystems advertised in the UI. An entry is added only when the engine ships its detector, runtime,
 * plan, diagnoser, strategies and tests (see .kiro/steering/v2-ecosystems-and-publishing.md).
 */
export interface EcosystemInfo {
  id: string;
  name: string;
  managers: string[];
  /** Short example of what gets repaired. */
  repairs: string;
}

export const SUPPORTED_ECOSYSTEMS: EcosystemInfo[] = [
  {
    id: 'npm',
    name: 'Node.js',
    managers: ['npm'],
    repairs: 'peer conflicts, dead git:// URLs, node-gyp, OpenSSL 3',
  },
  {
    id: 'python',
    name: 'Python',
    managers: ['pip', 'Poetry', 'uv', 'Pipenv'],
    repairs: 'unavailable versions, lockfile drift, removed stdlib APIs',
  },
  {
    id: 'rust',
    name: 'Rust',
    managers: ['Cargo'],
    repairs: 'missing crates, toolchain/edition mismatch, stale Cargo.lock',
  },
  {
    id: 'static',
    name: 'Static sites',
    managers: ['HTML/CSS/JS'],
    repairs: 'broken file references (letter case); checked statically, nothing is run',
  },
];

export const ECOSYSTEM_LABEL: Record<string, string> = {
  npm: 'Node.js',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  maven: 'Java (Maven)',
  static: 'Static site',
};

export type PublishModeId = 'PATCH_ONLY' | 'REVIEW_PR' | 'AUTO_PR';

export const PUBLISH_MODES: { id: PublishModeId; title: string; blurb: string; needsGithub: boolean }[] = [
  {
    id: 'PATCH_ONLY',
    title: 'Patch only',
    blurb: 'Download the verified patch and report. Nothing is sent to GitHub.',
    needsGithub: false,
  },
  {
    id: 'REVIEW_PR',
    title: 'Review, then PR',
    blurb: 'Inspect the verified diff, then approve a draft pull request.',
    needsGithub: true,
  },
  {
    id: 'AUTO_PR',
    title: 'Automatic PR',
    blurb: 'Open a draft pull request as soon as a repair is fully verified.',
    needsGithub: true,
  },
];
