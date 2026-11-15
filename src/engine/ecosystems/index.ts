import type { Workspace } from '../core/workspace';
import { npmEcosystem } from './npm';
import { goEcosystem } from './go';
import { mavenEcosystem } from './maven';
import { pythonEcosystem } from './python';
import { rustEcosystem } from './rust';
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
