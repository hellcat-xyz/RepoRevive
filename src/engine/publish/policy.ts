import type { Health, StepName, StepResult } from '../core/types';
import { STEP_NAMES } from '../core/types';

export type PublishModeName = 'PATCH_ONLY' | 'REVIEW_PR' | 'AUTO_PR';

export interface PublishPolicyInput {
  mode: PublishModeName;
  /** Authenticated GitHub user id performing/owning the request; null when anonymous. */
  actorUserId: string | null;
  jobOwnerId: string | null;
  /** REVIEW_PR needs an explicit approval click; AUTO_PR was opted into at submission time. */
  approved: boolean;
  autoEnabledAtSubmission: boolean;
  health: Health;
  allowPartial: boolean;
  finalSteps: Record<StepName, Pick<StepResult, 'status' | 'skipReason'>> | null;
  publishableFiles: number;
  baseKnown: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  reasons: string[];
}

/**
 * Single gate in front of every publication. Pure and total: any missing evidence denies.
 * No mode bypasses a rule; modes only decide which authorization signal is required.
 */
export function evaluatePublishPolicy(i: PublishPolicyInput): PolicyDecision {
  const reasons: string[] = [];
  if (i.mode === 'PATCH_ONLY') reasons.push('The job is in patch-only mode; nothing is published to GitHub.');
  if (!i.actorUserId) reasons.push('Sign in with GitHub to publish.');
  else if (!i.jobOwnerId || i.jobOwnerId !== i.actorUserId)
    reasons.push('Only the user who started this resurrection can publish it.');
  if (i.mode === 'REVIEW_PR' && !i.approved) reasons.push('The diff has not been approved for publishing.');
  if (i.mode === 'AUTO_PR' && !i.autoEnabledAtSubmission)
    reasons.push('Automatic pull requests were not enabled when the job was started.');

  const healthOk = i.health === 'REVIVED' || (i.health === 'PARTIALLY_REVIVED' && i.allowPartial);
  if (!healthOk)
    reasons.push(
      i.health === 'PARTIALLY_REVIVED'
        ? 'The repair is only partial; publishing a partial repair needs a separate opt-in.'
        : `Final verification did not pass (health: ${i.health}).`,
    );
  if (!i.finalSteps) reasons.push('There is no final verification result.');
  else {
    if (i.finalSteps.install.status !== 'passed')
      reasons.push('Installation did not pass in the final verification.');
    for (const s of STEP_NAMES) {
      const r = i.finalSteps[s];
      if (r.status === 'failed' || r.status === 'timeout') {
        if (i.health === 'REVIVED') reasons.push(`The ${s} step failed in the final verification.`);
      }
    }
  }
  if (i.publishableFiles <= 0) reasons.push('There are no publishable changes (empty patch).');
  if (!i.baseKnown) reasons.push('The base commit of the verified patch is unknown.');
  return { allowed: reasons.length === 0, reasons };
}
