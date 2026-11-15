import { ResurrectionError } from './errors';

export const MAX_ARGS = 64;
export const MAX_ARG_LENGTH = 8192;

/**
 * Validate an argv array before it reaches the sandbox: non-empty, bounded, no NUL bytes.
 * Returns the same array for chaining.
 */
export function assertSafeCommand(argv: readonly string[]): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS)
    throw new ResurrectionError('INTERNAL', 'Invalid command: wrong argument count');
  for (const a of argv) {
    if (typeof a !== 'string' || a.length > MAX_ARG_LENGTH || a.includes('\0'))
      throw new ResurrectionError('INTERNAL', 'Invalid command: bad argument');
  }
  return [...argv];
}

/** Allow-list for values interpolated into fixed `sh -c` templates (versions, package names, paths). */
const SHELL_SAFE = /^[A-Za-z0-9._\-+=:/@^~,]+$/;

export function shellSafe(value: string): string {
  if (!SHELL_SAFE.test(value) || value.length > 200)
    throw new ResurrectionError('INTERNAL', `Refusing to interpolate unsafe value "${value.slice(0, 40)}"`);
  return value;
}

/** Single-quote a value for `sh` (used only after `shellSafe` has failed to apply, e.g. spec ranges). */
export function shQuote(value: string): string {
  if (value.includes('\0')) throw new ResurrectionError('INTERNAL', 'NUL in shell value');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
