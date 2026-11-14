/** Strict GitHub repository URL parsing. Shared by the UI (instant feedback) and the API (authority). */

export interface RepoRef {
  owner: string;
  name: string;
  /** Canonical `https://github.com/<owner>/<name>` */
  url: string;
}

// GitHub rules: owner 1-39 chars, alphanumeric or single hyphens, not starting/ending with hyphen.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// Repository names: letters, digits, '.', '_', '-' up to 100 chars; '.' and '..' are reserved.
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

export function isValidRepoName(name: string): boolean {
  return REPO_RE.test(name) && name !== '.' && name !== '..' && !name.toLowerCase().endsWith('.git');
}

export type ParseResult = { ok: true; repo: RepoRef } | { ok: false; error: string };

export function parseGitHubUrl(input: string): ParseResult {
  const raw = input.trim();
  if (raw.length === 0) return { ok: false, error: 'Paste a GitHub repository URL.' };
  if (raw.length > 300) return { ok: false, error: 'That URL is too long.' };

  let url: URL;
  try {
    // Accept "github.com/owner/repo" without scheme for convenience.
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only https://github.com URLs are supported.' };
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return { ok: false, error: 'Only public github.com repositories are supported.' };
  }
  if (url.username || url.password || url.port) {
    return { ok: false, error: 'URLs with credentials or ports are not allowed.' };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return { ok: false, error: 'The URL must include an owner and a repository.' };
  const [owner = '', rawName = ''] = segments;
  // Allow /tree/<ref>, /blob/..., etc. after the repository; ignore them.
  const name = rawName.replace(/\.git$/i, '');

  if (!isValidOwner(owner)) return { ok: false, error: 'The repository owner is not valid.' };
  if (!isValidRepoName(name)) return { ok: false, error: 'The repository name is not valid.' };

  return { ok: true, repo: { owner, name, url: `https://github.com/${owner}/${name}` } };
}
