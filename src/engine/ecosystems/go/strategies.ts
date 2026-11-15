import { pickEraVersion } from '../../core/era';
import type { FileEdit } from '../../core/types';
import type { FixStrategy } from '../types';

function goMinorOf(v: string): number | null {
  const m = /^1\.(\d{1,2})/.exec(v);
  return m ? Number(m[1]) : null;
}

/** Replace the version of `path` in a go.mod text. Null if the module is not required. */
export function setModuleVersion(goMod: string, path: string, version: string): string | null {
  const esc = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(`(^\\s*(?:require\\s+)?${esc}\\s+)v[^\\s]+`, 'm');
  return re.test(goMod) ? goMod.replace(re, `$1${version}`) : null;
}

export const goTidy: FixStrategy = {
  id: 'go-mod-tidy',
  handles: ['lockfile-drift', 'missing-module'],
  invasiveness: 1,
  async propose(issue, ctx) {
    const files = await ctx.sandbox.regenerateFiles([]);
    if (files.length === 0) {
      ctx.log('`go mod tidy` produced no change.');
      return [];
    }
    return [
      {
        strategyId: this.id,
        title: 'Run go mod tidy',
        rationale: `${issue.title}. "go mod tidy" in the sandbox brings go.mod and go.sum in line with the imports in the source.`,
        edits: files,
        kind: 'runtime',
      },
    ];
  },
};

export const goPinToolchain: FixStrategy = {
  id: 'go-pin-toolchain',
  handles: ['toolchain-mismatch'],
  invasiveness: 2,
  async propose(issue, ctx) {
    const need = goMinorOf(issue.data?.required ?? '');
    const cur = goMinorOf(ctx.runtime.version);
    if (need === null || cur === null || need <= cur) return [];
    return [
      {
        strategyId: this.id,
        title: `Use Go 1.${need} via .go-version`,
        rationale: `The module requires Go ${issue.data?.required}. ".go-version" selects the Go 1.${need} image for installs, builds and tests (was 1.${cur}).`,
        edits: [{ path: '.go-version', content: `1.${need}\n` }],
        kind: 'runtime',
      },
    ];
  },
};

export const goRepinModule: FixStrategy = {
  id: 'go-repin-module',
  handles: ['missing-version'],
  invasiveness: 3,
  async propose(issue, ctx) {
    const mod = issue.data?.module;
    const bad = issue.data?.version;
    if (!mod || !bad) return [];
    const p = await ctx.registry.packument(mod);
    if (!p) {
      ctx.log(`Module ${mod} is unknown to the Go proxy; not guessing a replacement.`);
      return [];
    }
    if (p.versions.includes(bad.replace(/^v/, ''))) return [];
    const pick = pickEraVersion(p, ctx.commitDate);
    const text = await ctx.ws.current('go.mod');
    if (!pick || text === null) return [];
    const next = setModuleVersion(text, mod, `v${pick.version}`);
    if (next === null || next === text) return [];
    const edits: FileEdit[] = [{ path: 'go.mod', content: next }];
    const sum = await ctx.sandbox.regenerateFiles(edits);
    return [
      {
        strategyId: this.id,
        title: `Re-pin ${mod} to v${pick.version}`,
        rationale: `${mod}@${bad} does not exist on the Go proxy. v${pick.version} is the ${pick.basis === 'era' ? "newest release before the repository's last commit" : 'newest release'}; go.sum is regenerated from it.`,
        edits: [...edits.filter((e) => !sum.some((s) => s.path === e.path)), ...sum],
        kind: 'runtime',
      },
    ];
  },
};

export const goStrategies = [goTidy, goPinToolchain, goRepinModule];
