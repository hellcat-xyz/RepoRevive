import { validateRelativePath } from '../../core/workspace';
import type { FixProposal, Issue } from '../../core/types';
import { isCommitSha } from '../../upstream/github-http';
import type { FixStrategy, StrategyContext } from '../types';
import { resolveScriptChain, scriptFileFromCommand } from './lifecycle';
import { readManifest, scriptsOf } from './manifest';

/** `https://raw.githubusercontent.com/<owner>/<repo>/<ref>[/<path>]` inside source text. */
const RAW_URL =
  /(https:\/\/raw\.githubusercontent\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([\w.-]{1,100})\/(refs\/heads\/[\w.-]+|[\w.-]+)((?:\/[\w@.+-]+)*)/g;

export interface RawRef {
  owner: string;
  repo: string;
  /** Branch/tag name without `refs/heads/`. */
  ref: string;
  /** Path after the ref, with a leading slash, or "". */
  rest: string;
}

const refKey = (r: Pick<RawRef, 'owner' | 'repo' | 'ref'>) => `${r.owner}/${r.repo}@${r.ref}`;

/** All raw.githubusercontent.com URLs whose ref is not already a full commit SHA. */
export function findFloatingRawRefs(text: string): RawRef[] {
  const out: RawRef[] = [];
  for (const m of text.matchAll(RAW_URL)) {
    const ref = m[4]!.replace(/^refs\/heads\//, '');
    if (isCommitSha(ref)) continue;
    out.push({ owner: m[2]!, repo: m[3]!, ref, rest: m[5] ?? '' });
  }
  return out;
}

/**
 * Replace only the ref segment of floating raw.githubusercontent.com URLs using `shas`
 * (key `owner/repo@ref`). Everything else in the text is left byte-identical, and the result is a
 * fixed point: pinned URLs are never touched again.
 */
export function rewriteRawRefs(text: string, shas: ReadonlyMap<string, string>): string {
  return text.replace(
    RAW_URL,
    (whole, host: string, owner: string, repo: string, refRaw: string, rest: string) => {
      const ref = refRaw.replace(/^refs\/heads\//, '');
      const sha = isCommitSha(ref) ? undefined : shas.get(refKey({ owner, repo, ref }));
      return sha ? `${host}${owner}/${repo}/${sha}${rest ?? ''}` : whole;
    },
  );
}

function isScriptPath(p: string): boolean {
  try {
    validateRelativePath(p);
  } catch {
    return false;
  }
  return !p.split('/').some((s) => s === 'node_modules' || s === '.git' || s === '.github');
}

async function candidateFiles(issue: Issue, ctx: StrategyContext): Promise<string[]> {
  const files: string[] = [];
  const push = (p: string | null | undefined) => {
    if (p && isScriptPath(p) && !files.includes(p)) files.push(p);
  };
  push(issue.diagnostic?.file ?? issue.data?.file);
  const m = await readManifest(ctx.ws);
  const scripts = m ? scriptsOf(m.json) : {};
  const hook = issue.diagnostic?.lifecycle ?? issue.data?.lifecycle;
  if (hook) for (const f of resolveScriptChain(scripts, hook)) push(f);
  for (const line of issue.evidence.split(/\r?\n/)) {
    const cmd = /^>\s+(.+)$/.exec(line.trim())?.[1];
    if (cmd) push(scriptFileFromCommand(cmd));
  }
  return files.slice(0, 6);
}

/**
 * A project script downloads from `raw.githubusercontent.com/.../<floating-ref>/...` and the upstream
 * project has since moved or deleted the file. Re-point the ref at the upstream commit that was current
 * when this repository was last updated, but only if the missing resources exist there.
 */
export const upstreamRefPin: FixStrategy = {
  id: 'upstream-ref-pin',
  handles: ['broken-upstream-resource'],
  invasiveness: 2,
  async propose(issue, ctx): Promise<FixProposal[]> {
    if (!ctx.upstream) {
      ctx.log('upstream-ref-pin: no upstream resolver configured.');
      return [];
    }
    if (!ctx.commitDate) {
      ctx.log('upstream-ref-pin: the repository has no commit date to match upstream against.');
      return [];
    }
    if (issue.data?.owner === 'dependency') {
      ctx.log('upstream-ref-pin: the failing script belongs to a dependency, not to this repository.');
      return [];
    }

    const files = await candidateFiles(issue, ctx);
    const sources = new Map<string, string>();
    const refs = new Map<string, RawRef & { bases: Set<string> }>();
    for (const f of files) {
      const text = await ctx.ws.current(f).catch(() => null);
      if (text === null) continue;
      sources.set(f, text);
      for (const r of findFloatingRawRefs(text)) {
        const k = refKey(r);
        const entry = refs.get(k) ?? { ...r, bases: new Set<string>() };
        if (r.rest) entry.bases.add(r.rest);
        refs.set(k, entry);
      }
    }
    if (refs.size === 0) {
      ctx.log(
        `upstream-ref-pin: no floating raw.githubusercontent.com URLs found in ${files.join(', ') || 'any script'}.`,
      );
      return [];
    }

    const scriptNames = new Set(files.map((f) => f.split('/').pop()!));
    const resources = (issue.diagnostic?.resources ?? []).filter((r) => !scriptNames.has(r));
    const shas = new Map<string, string>();
    for (const [k, r] of refs) {
      const sha = await ctx.upstream.commitAt(r.owner, r.repo, r.ref, ctx.commitDate);
      if (!sha) {
        ctx.log(`upstream-ref-pin: ${k} has no commit at or before ${ctx.commitDate.slice(0, 10)}.`);
        continue;
      }
      // Every resource named in the failure must exist at that commit, otherwise pinning cannot help.
      let ok = true;
      for (const res of resources) {
        let found = false;
        for (const base of r.bases.size ? r.bases : new Set([''])) {
          const candidates = base.endsWith(`/${res}`) ? [base] : [`${base}/${res}`];
          for (const c of candidates) {
            if (await ctx.upstream.fileExists(r.owner, r.repo, sha, c.replace(/^\//, ''))) found = true;
          }
        }
        if (!found) {
          ctx.log(
            `upstream-ref-pin: ${res} does not exist in ${r.owner}/${r.repo} at ${sha.slice(0, 10)} either.`,
          );
          ok = false;
          break;
        }
      }
      if (ok) {
        shas.set(k, sha);
        ctx.log(
          `upstream-ref-pin: ${k} resolves to ${sha.slice(0, 12)}${resources.length ? `; ${resources.join(', ')} exist there` : ''}.`,
        );
      }
    }
    if (shas.size === 0) return [];

    const edits = [...sources]
      .map(([path, text]) => ({ path, before: text, content: rewriteRawRefs(text, shas) }))
      .filter((e) => e.content !== e.before)
      .map(({ path, content }) => ({ path, content }));
    if (edits.length === 0) return [];

    const pinned = [...shas].map(([k, sha]) => `${k} -> ${sha.slice(0, 12)}`).join(', ');
    return [
      {
        strategyId: this.id,
        title: `Pin upstream download URLs to their ${ctx.commitDate.slice(0, 10)} commit (${pinned})`,
        rationale:
          `The script downloads from a moving branch and the upstream project has since moved or removed ` +
          `${resources.length ? resources.join(', ') : 'the requested files'} (HTTP ${issue.data?.httpStatus ?? '404'}). ` +
          `Pinning the ref to the upstream commit that was current at this repository's last commit ` +
          `(${ctx.commitDate.slice(0, 10)}) restores the layout the script was written for. ` +
          `Only the ref segment of each URL changes; no file content is written by RepoRevive.`,
        edits,
        kind: 'runtime',
      },
    ];
  },
};
