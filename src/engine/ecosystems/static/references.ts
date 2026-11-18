import path from 'node:path';
import type { Workspace } from '../../core/workspace';
import { validateRelativePath } from '../../core/workspace';
import { walkFiles } from '../shared';

/** A reference found in an HTML or CSS file. `start`/`end` delimit the value inside its quotes. */
export interface RawReference {
  tag: string;
  attr: string;
  ref: string;
  start: number;
  end: number;
}

export interface BrokenReference {
  file: string;
  tag: string;
  attr: string;
  ref: string;
  /** Repository-relative path the reference resolves to. */
  target: string;
  /** Reference text that would resolve to an existing file with different letter case. */
  suggestion?: string;
}

export const MAX_FILES_SCANNED = 300;
export const MAX_BROKEN_REFERENCES = 30;
const MAX_FILE_BYTES = 1_000_000;

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/** Blank out comments and inline script/style bodies, keeping offsets stable. */
export function maskHtml(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
      (_m, a: string, b: string, c: string) => a + blank(b) + c,
    )
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_m, a: string, b: string, c: string) => a + blank(b) + c,
    );
}

const TAG_ATTRS: Record<string, string[]> = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  script: ['src'],
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  embed: ['src'],
  iframe: ['src'],
  input: ['src'],
};
const LINK_REL_RE = /stylesheet|icon|manifest|preload|modulepreload/i;

export function extractHtmlReferences(text: string): RawReference[] {
  const masked = maskHtml(text);
  const out: RawReference[] = [];
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  for (const tm of masked.matchAll(tagRe)) {
    const tag = tm[1]!.toLowerCase();
    if (tag === 'base' && /\bhref\s*=/i.test(tm[2]!)) return []; // a <base> changes every relative URL
    const attrs = TAG_ATTRS[tag];
    if (!attrs) continue;
    const attrText = tm[2]!;
    if (tag === 'link') {
      const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrText);
      if (!rel || !LINK_REL_RE.test(rel[1] ?? rel[2] ?? rel[3] ?? '')) continue;
    }
    const attrBase = tm.index! + 1 + tm[1]!.length;
    const attrRe = /\b([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/g;
    for (const am of attrText.matchAll(attrRe)) {
      const name = am[1]!.toLowerCase();
      if (!attrs.includes(name)) continue;
      const value = am[2] ?? am[3] ?? am[4] ?? '';
      const quoted = am[2] !== undefined || am[3] !== undefined;
      const start = attrBase + am.index! + am[0].length - value.length - (quoted ? 1 : 0);
      out.push({ tag, attr: name, ref: value, start, end: start + value.length });
    }
  }
  return out;
}

export function extractCssReferences(text: string): RawReference[] {
  const masked = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  const out: RawReference[] = [];
  const push = (m: RegExpMatchArray, group: number, attr: string) => {
    const value = m[group]!;
    const start = m.index! + m[0].lastIndexOf(value);
    out.push({ tag: 'css', attr, ref: value.trim(), start, end: start + value.length });
  };
  for (const m of masked.matchAll(/url\(\s*(["']?)([^"')]+?)\1\s*\)/gi)) push(m, 2, 'url');
  for (const m of masked.matchAll(/@import\s+(["'])([^"']+)\1/gi)) push(m, 2, '@import');
  return out;
}

export function extractReferences(file: string, text: string): RawReference[] {
  return /\.css$/i.test(file) ? extractCssReferences(text) : extractHtmlReferences(text);
}

/**
 * Repository-relative path a reference points to, or null when it is not a local file reference
 * (absolute URLs, fragments, data URIs, templating placeholders, paths outside the repository).
 */
export function localTarget(fromFile: string, rawRef: string): string | null {
  const r = rawRef.trim();
  if (!r || r.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('//')) return null;
  if (/\{\{|\$\{|<%|\{%|<\?|\[\[|\\/.test(r)) return null;
  let p = r.replace(/[?#].*$/s, '');
  if (!p) return null;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the raw text
  }
  const dir = path.posix.dirname(fromFile);
  const joined = p.startsWith('/') ? p.slice(1) : path.posix.join(dir === '.' ? '' : dir, p);
  const normalized = path.posix.normalize(joined).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) return null;
  if (normalized === '' || normalized === '.') return '';
  try {
    validateRelativePath(normalized);
  } catch {
    return null;
  }
  return normalized;
}

export type Resolution = { state: 'exact' } | { state: 'case'; corrected: string } | { state: 'missing' };

/** Case-exact existence check (the host file system may be case-insensitive; Linux and GitHub Pages are not). */
export async function resolveExact(
  ws: Workspace,
  rel: string,
  cache: Map<string, { name: string; type: 'file' | 'dir' }[]>,
): Promise<Resolution> {
  if (rel === '') return { state: 'exact' };
  let dir = '';
  const out: string[] = [];
  let caseOnly = false;
  for (const seg of rel.split('/')) {
    let entries = cache.get(dir);
    if (!entries) {
      entries = await ws.list(dir).catch(() => []);
      cache.set(dir, entries);
    }
    const exact = entries.find((e) => e.name === seg);
    if (exact) {
      out.push(seg);
    } else {
      const ci = entries.filter((e) => e.name.toLowerCase() === seg.toLowerCase());
      if (ci.length !== 1) return { state: 'missing' };
      out.push(ci[0]!.name);
      caseOnly = true;
    }
    dir = out.join('/');
  }
  return caseOnly ? { state: 'case', corrected: out.join('/') } : { state: 'exact' };
}

function relativeFrom(fromDir: string, target: string): string {
  const a = fromDir === '.' || fromDir === '' ? [] : fromDir.split('/');
  const b = target.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** New text for a reference so that it points at `corrected`, keeping its style (relative, root-relative, query, hash). */
export function rewriteReference(file: string, originalRef: string, corrected: string): string {
  const m = /^([^?#]*)([\s\S]*)$/.exec(originalRef.trim())!;
  const body = m[1]!;
  const suffix = m[2]!;
  const rootRelative = body.startsWith('/');
  let p = rootRelative ? `/${corrected}` : relativeFrom(path.posix.dirname(file), corrected);
  if (!rootRelative && body.startsWith('./')) p = `./${p}`;
  if (body.includes('%')) p = encodeURI(p);
  if (body.endsWith('/') && !p.endsWith('/')) p += '/';
  return p + suffix;
}

/** Finds local references in HTML and CSS files that do not resolve to an existing file. Read-only. */
export async function findBrokenReferences(ws: Workspace): Promise<BrokenReference[]> {
  const files = (await walkFiles(ws))
    .filter((f) => /\.(?:html?|css)$/i.test(f))
    .sort()
    .slice(0, MAX_FILES_SCANNED);
  const cache = new Map<string, { name: string; type: 'file' | 'dir' }[]>();
  const broken: BrokenReference[] = [];
  for (const file of files) {
    const text = await ws.current(file).catch(() => null);
    if (text === null || text.length > MAX_FILE_BYTES) continue;
    const seen = new Set<string>();
    for (const r of extractReferences(file, text)) {
      if (seen.has(r.ref)) continue;
      seen.add(r.ref);
      const target = localTarget(file, r.ref);
      if (target === null) continue;
      let res: Resolution;
      try {
        res = await resolveExact(ws, target, cache);
      } catch {
        continue; // unreadable or unsafe path (for example a symlink): do not guess
      }
      if (res.state === 'exact') continue;
      broken.push({
        file,
        tag: r.tag,
        attr: r.attr,
        ref: r.ref,
        target,
        ...(res.state === 'case' ? { suggestion: rewriteReference(file, r.ref, res.corrected) } : {}),
      });
      if (broken.length >= MAX_BROKEN_REFERENCES) return broken;
    }
  }
  return broken;
}
