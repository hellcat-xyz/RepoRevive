import type { FixStrategy } from '../types';
import { extractReferences } from './references';

/**
 * Rewrites a reference to the existing file that differs from it only by letter case. The target is
 * found by listing the repository, so nothing is invented. Linux servers and GitHub Pages are
 * case-sensitive, which is why these links break online.
 */
export const staticReferenceCaseFix: FixStrategy = {
  id: 'static-reference-case-fix',
  handles: ['broken-reference'],
  invasiveness: 2,
  async propose(issue, ctx) {
    const file = issue.data?.file;
    const ref = issue.data?.ref;
    const suggestion = issue.data?.suggestion;
    if (!file || !ref) return [];
    if (!suggestion) {
      ctx.log(`No file matching "${ref}" exists in any letter case; not guessing a replacement.`);
      return [];
    }
    const text = await ctx.ws.current(file).catch(() => null);
    if (text === null) return [];
    const spans = extractReferences(file, text)
      .filter((r) => r.ref === ref)
      .sort((a, b) => b.start - a.start);
    if (spans.length === 0) return [];
    let next = text;
    for (const s of spans) next = next.slice(0, s.start) + suggestion + next.slice(s.end);
    if (next === text) return [];
    return [
      {
        strategyId: 'static-reference-case-fix',
        title: `Fix reference "${ref}" in ${file}`,
        rationale: `"${ref}" does not match any file exactly, but "${suggestion}" does when letter case is respected. Case-sensitive servers (Linux, GitHub Pages) fail on the original.`,
        edits: [{ path: file, content: next }],
        kind: 'static',
      },
    ];
  },
};

export const staticStrategies: FixStrategy[] = [staticReferenceCaseFix];
