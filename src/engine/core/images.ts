/**
 * Allow-list of runtime images the sandbox may execute. Pure and shared by the engine (to build
 * runtime selections) and the Docker sandbox (to refuse anything else). Image names never come from
 * repository files or model output; versions are validated here first.
 */

export const RUNTIME_FAMILIES = ['node', 'python', 'rust', 'go', 'java'] as const;
export type RuntimeFamily = (typeof RUNTIME_FAMILIES)[number];

interface ImageRule {
  family: RuntimeFamily;
  pattern: RegExp;
}

/** Update policy: bump these patterns (and the version tables in each ecosystem) deliberately via PR. */
const RULES: ImageRule[] = [
  { family: 'node', pattern: /^node:\d{1,2}$/ },
  { family: 'python', pattern: /^python:3\.(?:[6-9]|1[0-4])-slim$/ },
  { family: 'rust', pattern: /^rust:1\.\d{1,3}(?:\.\d{1,2})?-slim$|^rust:1-slim$/ },
  { family: 'go', pattern: /^golang:1\.\d{1,2}(?:\.\d{1,2})?$/ },
  { family: 'java', pattern: /^maven:3\.9-eclipse-temurin-(?:8|11|17|21)$/ },
];

export function imageFamily(image: string): RuntimeFamily | null {
  if (typeof image !== 'string' || image.length > 64) return null;
  return RULES.find((r) => r.pattern.test(image))?.family ?? null;
}

export function isAllowedImage(image: string): boolean {
  return imageFamily(image) !== null;
}

/** Cache environment for a family. Paths are inside the `/cache` mount, never host paths. */
export function cacheEnvFor(family: RuntimeFamily): Record<string, string> {
  switch (family) {
    case 'node':
      return { npm_config_cache: '/cache/npm' };
    case 'python':
      return {
        PIP_CACHE_DIR: '/cache/pip',
        POETRY_CACHE_DIR: '/cache/poetry',
        UV_CACHE_DIR: '/cache/uv',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      };
    case 'rust':
      return { CARGO_HOME: '/cache/cargo', CARGO_TARGET_DIR: '/cache/target' };
    case 'go':
      return { GOMODCACHE: '/cache/go/mod', GOCACHE: '/cache/go/build', GOFLAGS: '-buildvcs=false' };
    case 'java':
      return { MAVEN_CONFIG: '/cache/m2' };
  }
}

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Env names that must never reach an untrusted container. */
const FORBIDDEN_ENV =
  /^(DATABASE_URL|LLM_API_KEY|GITHUB_.*|DOCKER_.*|AWS_.*|REPOREVIVE_.*|.*TOKEN.*|.*SECRET.*)$/i;

export function isSafeEnvEntry(key: string, value: string): boolean {
  return ENV_KEY_RE.test(key) && !FORBIDDEN_ENV.test(key) && !value.includes('\0') && value.length <= 4096;
}
