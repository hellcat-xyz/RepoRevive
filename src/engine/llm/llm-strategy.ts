import { z } from 'zod';
import type { FileEdit, Issue } from '../core/types';
import type { FixStrategy, StrategyContext } from '../ecosystems/types';
import { buildLlmContext } from './context';
import { checkEditIntegrity } from './integrity';
import { isAllowedLlmPath } from './paths';

export { isAllowedLlmPath } from './paths';
export { referencedFiles } from './context';

const MAX_TOTAL_EDIT_BYTES = 40_000;
export const DEFAULT_LLM_MAX_PER_ISSUE = 3;
export const LLM_STRATEGY_ID = 'llm-source-fix';

export const LlmOutputSchema = z.object({
  rationale: z.string().min(1).max(2000),
  edits: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        search: z.string().max(12_000),
        replace: z.string().max(12_000),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * Turn validated search/replace edits into full-file edits. Each search must match exactly once, every
 * path must be allowed, and no resulting file may weaken the project (see `checkEditIntegrity`).
 */
export async function materializeEdits(
  ctx: Pick<StrategyContext, 'ws'>,
  edits: z.infer<typeof LlmOutputSchema>['edits'],
): Promise<{ edits: FileEdit[] } | { error: string }> {
  const files = new Map<string, string | null>();
  const originals = new Map<string, string | null>();
  let total = 0;
  for (const e of edits) {
    if (!isAllowedLlmPath(e.path)) return { error: `Model proposed a disallowed path: ${e.path}` };
    total += e.replace.length;
    if (total > MAX_TOTAL_EDIT_BYTES) return { error: 'Model proposed an edit that is too large.' };
    if (!files.has(e.path)) {
      const current = await ctx.ws.current(e.path);
      files.set(e.path, current);
      originals.set(e.path, current);
    }
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
  for (const [p, content] of files) {
    const violation = checkEditIntegrity(p, originals.get(p) ?? null, content ?? '');
    if (violation) return { error: violation };
  }
  return { edits: [...files.entries()].map(([path, content]) => ({ path, content })) };
}

export const llmSourceFix: FixStrategy = {
  id: LLM_STRATEGY_ID,
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
    'test-failure',
    'compile-error',
    'legacy-syntax',
    'removed-stdlib-api',
    'import-path',
    'missing-feature',
    'build-script-failure',
  ],
  invasiveness: 5,
  async propose(issue: Issue, ctx) {
    if (!ctx.llm || issue.step === 'static') return [];
    const earlier = (ctx.attempts ?? []).filter(
      (a) => a.strategyId === LLM_STRATEGY_ID && a.fingerprint === issue.fingerprint,
    );
    const limit = ctx.llmMaxPerIssue ?? DEFAULT_LLM_MAX_PER_ISSUE;
    if (earlier.length >= limit) {
      ctx.log(`AI strategy already tried ${earlier.length} time(s) for "${issue.title}"; not asking again.`);
      return [];
    }

    const step = ctx.current.steps[issue.step];
    const log = step.logTail.split(/\r?\n/).slice(-150).join('\n');
    const { files, tree } = await buildLlmContext(ctx, issue, log);
    // Attempts for this issue first, so the model sees what already failed here.
    const all = ctx.attempts ?? [];
    const sameIssue = all.filter((a) => a.fingerprint === issue.fingerprint);
    const others = all.filter((a) => a.fingerprint !== issue.fingerprint);
    const prior = [...others.slice(-3), ...sameIssue].slice(-8);

    let raw: unknown;
    try {
      raw = await ctx.llm.proposeEdits({
        step: issue.step,
        issueTitle: issue.title,
        logExcerpt: log,
        files,
        tree,
        runtime: ctx.runtime.label,
        ecosystem: ctx.ecosystem?.id,
        packageManager: ctx.ecosystem?.packageManager,
        command: step.command,
        priorAttempts: prior.map((a) => ({
          title: a.title,
          status: a.status,
          reason: a.reason?.slice(0, 200),
          ...(a.detail ? { detail: a.detail.slice(-1500) } : {}),
        })),
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
