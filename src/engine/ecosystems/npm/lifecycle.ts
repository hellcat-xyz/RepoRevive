/**
 * Pure helpers that read npm output and package.json scripts to find which script failed and why.
 * Nothing here touches the filesystem or runs code.
 */

export const LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
] as const;

const HEADER = /^>\s+((?:@[^/\s]+\/)?[^@\s]+)@(\d[^\s]*)\s+([\w:.-]+)\s*$/;
const COMMAND_LINE = /^>\s+(\S.*?)\s*$/;

export interface LifecycleFailure {
  /** Hook name, e.g. `postinstall`. */
  hook: string;
  /** Package whose script is running (the project itself or a dependency). */
  package: string;
  /** The innermost command npm printed (the thing that actually failed). */
  command: string | null;
  /** Repository-relative script file the command runs, when recognisable. */
  file: string | null;
}

/** Find the lifecycle hook that was running when npm failed, using the `> pkg@ver hook` banners. */
export function parseLifecycleFailure(log: string): LifecycleFailure | null {
  let hook: { name: string; pkg: string } | null = null;
  let command: string | null = null;
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(/^npm\s+(?:info|notice|warn)\s+/i, '');
    const h = HEADER.exec(line);
    if (h) {
      if ((LIFECYCLE_HOOKS as readonly string[]).includes(h[3]!)) {
        hook = { name: h[3]!, pkg: h[1]! };
        command = null;
      }
      continue;
    }
    if (!hook) continue;
    const c = COMMAND_LINE.exec(line);
    if (c) command = c[1]!;
  }
  if (!hook) return null;
  return {
    hook: hook.name,
    package: hook.pkg,
    command,
    file: command ? scriptFileFromCommand(command) : null,
  };
}

const RUNNERS = /^(?:node|nodejs|tsx|ts-node|bash|sh)$/;

function safeRelative(p: string): string | null {
  const rel = p.replace(/^\.\//, '');
  if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '')) return null;
  return /^[\w@.\-/]+$/.test(rel) ? rel : null;
}

/** `node scripts/x.mjs --flag` -> `scripts/x.mjs`. Returns null for anything else. */
export function scriptFileFromCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++; // env prefixes
  if (tokens[i] === 'cross-env') {
    i++;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  }
  if (!tokens[i] || !RUNNERS.test(tokens[i]!)) return null;
  i++;
  while (i < tokens.length && tokens[i]!.startsWith('-')) i++;
  const file = tokens[i];
  if (!file || !/\.(?:m?js|cjs|m?ts|sh)$/.test(file)) return null;
  return safeRelative(file);
}

const NPM_RUN = /^(?:npm|pnpm|yarn)\s+(?:run-script\s+|run\s+)?([\w:.-]+)(?:\s|$)/;

/**
 * Expand a package.json script into the script files it ends up running, following `npm run x`
 * chains and `&&`/`;` sequences. Bounded depth; order of appearance; no duplicates.
 */
export function resolveScriptChain(scripts: Record<string, string>, entry: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const walk = (name: string, depth: number) => {
    if (depth > 5 || seen.has(name)) return;
    seen.add(name);
    const body = scripts[name];
    if (!body) return;
    for (const part of body.split(/&&|\|\||;/)) {
      const cmd = part.trim();
      const run = NPM_RUN.exec(cmd);
      if (run && scripts[run[1]!] !== undefined) {
        walk(run[1]!, depth + 1);
        continue;
      }
      const f = scriptFileFromCommand(cmd);
      if (f && !files.includes(f)) files.push(f);
    }
  };
  walk(entry, 0);
  return files;
}

export interface HttpFailure {
  status: 404 | 410;
  line: string;
  /** File names mentioned on the failing line. */
  resources: string[];
  urls: string[];
}

const HTTP_STATUS =
  /\bHTTP\s*(?:status\s*)?(?:code\s*)?[:=]?\s*(404|410)\b|\b(404|410)\s+(?:Not Found|Gone)\b|\bstatus(?:\s+code)?[:=\s]+(404|410)\b/i;
const RESOURCE =
  /[\w@.-]+\.(?:m?[jt]sx?|cjs|css|scss|less|json|wasm|zip|tgz|tar\.gz|gz|svg|png|jpe?g|ttf|woff2?|txt|md|sh|ya?ml|node)\b/gi;

/** HTTP 404/410 failures printed by project scripts. npm registry 404s are handled elsewhere. */
export function findHttpFailures(log: string): HttpFailure[] {
  const out: HttpFailure[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = HTTP_STATUS.exec(line);
    if (!m) continue;
    if (/registry\.(?:npmjs\.org|yarnpkg\.com|npmmirror)/i.test(line)) continue;
    if (/^\s*npm\s+(?:error|ERR!)\s+404\s+Not Found - GET/i.test(line)) continue;
    const urls = [...line.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((u) => u[0]);
    const resources = [...new Set((line.match(RESOURCE) ?? []).filter((r) => !/^\d+\.\d+/.test(r)))];
    out.push({
      status: Number(m[1] ?? m[2] ?? m[3]) as 404 | 410,
      line: line.trim().slice(0, 300),
      resources,
      urls,
    });
  }
  return out;
}
