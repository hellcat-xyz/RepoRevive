import type { Workspace } from '../core/workspace';
import { npmEcosystem } from './npm';
import type { Ecosystem } from './types';

/** Registered ecosystems, in detection order. Add new languages/package managers here. */
export const ECOSYSTEMS: Ecosystem[] = [npmEcosystem];

export async function detectEcosystem(ws: Workspace, ecosystems = ECOSYSTEMS): Promise<Ecosystem | null> {
  for (const e of ecosystems) if (await e.detect(ws)) return e;
  return null;
}
