import { z } from 'zod';
import { isPatchablePath } from '../core/patch';
import type { FileEdit, Issue } from '../core/types';
import type { FixStrategy, StrategyContext } from '../ecosystems/types';

const MAX_FILE_BYTES = 12_000;
const MAX_FILES = 4;
const MAX_TOTAL_EDIT_BYTES = 20_000;

export const LlmOutputSchema = z.object({
  rationale: z.string().min(1).max(2000),
  edits: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        search: z.string().max(8000),
        replace: z.string().max(8000),
      }),
    )
    .min(1)
    .max(6),
});

const FORBIDDEN_SEGMENTS = new Set(['node_modules', '.git', '.github']);

export function isAllowedLlmPath(p: string): boolean {
  if (!isPatchablePath(p)) return false;
  const segs = p.split('/');
  if (segs.some((s) => FORBIDDEN_SEGMENTS.has(s))) return false;
  // Lockfiles are regenerated deterministically, never hand-edited by a model.
  return !/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p);
}

/** Paths mentioned in a stack trace / compiler output that point into the repository. */
export function referencedFiles(log: string): string[] {
  const out: string[] = [];
  const re =
    /(?:\/workspace\/|(?:^|[\s(]))((?:[\w@.-]+\/)*[\w@.-]+\.(?:js|jsx|mjs|cjs|ts|tsx|vue|json|scss|css))(?=[:(\s)]|$)/gm;
  for (const m of log.matchAll(re)) {
    const p = m[1]!.replace(/^\.\//, '');
    if (!p.includes('node_modules') && isAllowedLlmPath(p) && !out.includes(p)) out.push(p);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/** Turn validated search/replace edits into full-file edits. Each search must match exactly once. */
export async function materializeEdits(
  ctx: Pick<StrategyContext, 'ws'>,
  edits: z.infer<typeof LlmOutputSchema>['edits'],
): Promise<{ edits: FileEdit[] } | { error: string }> {
  const files = new Map<string, string | null>();
  let total = 0;
  for (const e of edits) {
    if (!isAllowedLlmPath(e.path)) return { error: `Model proposed a disallowed path: ${e.path}` };
    total += e.replace.length;
    if (total > MAX_TOTAL_EDIT_BYTES) return { error: 'Model proposed an edit that is too large.' };
    if (!files.has(e.path)) files.set(e.path, await ctx.ws.current(e.path));
    const current = files.get(e.path) ?? null;
    if (e.search === '') {
      if (current !== null) return { error: `Empty search for existing file ${e.path}.` };
      files.set(e.path, e.replace);
      continue;
    }
    if (current === null) return { error: `Model referenced missing file ${e.path}.` };
    const first = current.indexOf(e.search);
    if (first === -1) return { error: `Search text not found in ${e.path}.` };
    if (current.indexOf(e.search, first + 1) !== -1)
      return { error: `Search text is ambiguous in ${e.path}.` };
    files.set(e.path, current.slice(0, first) + e.replace + current.slice(first + e.search.length));
  }
  return { edits: [...files.entries()].map(([path, content]) => ({ path, content })) };
}

export const llmSourceFix: FixStrategy = {
  id: 'llm-source-fix',
  handles: [
    'unknown',
    'missing-module',
    'modern-syntax',
    'types-incompatible',
    'lifecycle-script-failure',
    'broken-upstream-resource',
    'missing-file',
    'typescript-error',
    'dependency-api-change',
    'build-failure',
  ],
  invasiveness: 5,
  async propose(issue: Issue, ctx) {
    if (!ctx.llm || issue.step === 'static') return [];
    const step = ctx.current.steps[issue.step];
    const log = step.logTail.split(/\r?\n/).slice(-150).join('\n');
    const files: { path: string; content: string }[] = [];
    const pkg = await ctx.ws.current('package.json');
    if (pkg) files.push({ path: 'package.json', content: pkg.slice(0, MAX_FILE_BYTES) });
    const hinted = [issue.diagnostic?.file].filter(
      (p): p is string => typeof p === 'string' && isAllowedLlmPath(p),
    );
    for (const p of [...hinted, ...referencedFiles(log)]) {
      if (files.some((f) => f.path === p)) continue;
      const content = await ctx.ws.current(p).catch(() => null);
      if (content && content.length <= MAX_FILE_BYTES) files.push({ path: p, content });
    }

    let raw: unknown;
    try {
      raw = await ctx.llm.proposeEdits({
        step: issue.step,
        issueTitle: issue.title,
        logExcerpt: log,
        files,
        runtime: ctx.runtime.label,
      });
    } catch (err) {
      ctx.log(`AI strategy unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const parsed = LlmOutputSchema.safeParse(raw);
    if (!parsed.success) {
      ctx.log('AI strategy returned an invalid response; ignoring it.');
      return [];
    }
    const result = await materializeEdits(ctx, parsed.data.edits);
    if ('error' in result) {
      ctx.log(`AI strategy proposal rejected: ${result.error}`);
      return [];
    }
    return [
      {
        strategyId: this.id,
        title: `AI-proposed fix: ${parsed.data.rationale.split(/[.\n]/)[0]!.slice(0, 90)}`,
        rationale: `${parsed.data.rationale}\n\n(Generated by an AI model and kept only because sandbox verification supported it.)`,
        edits: result.edits,
        kind: 'runtime',
      },
    ];
  },
};
