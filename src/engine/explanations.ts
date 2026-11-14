import type { IssueKind } from './core/types';

/** Human explanations used by the report and UI. Every IssueKind must have an entry. */
export const ISSUE_EXPLANATIONS: Record<IssueKind, { cause: string; advice: string }> = {
  'peer-conflict': {
    cause:
      'npm 7 and later treat conflicting peer dependency ranges as a hard error. Older projects installed fine under npm 6, which only warned.',
    advice:
      'Align the conflicting packages to versions whose peer ranges overlap, then remove legacy-peer-deps.',
  },
  'lockfile-drift': {
    cause: 'package-lock.json no longer matches package.json, so `npm ci` refuses to install.',
    advice: 'Run `npm install` locally and commit the updated lockfile.',
  },
  'git-protocol': {
    cause:
      'A dependency is fetched over git:// or SSH. GitHub turned off the unauthenticated git protocol in March 2022, and anonymous environments have no SSH keys.',
    advice: 'Use git+https:// URLs or, better, a published npm version of the dependency.',
  },
  'native-build': {
    cause:
      'A native addon (compiled with node-gyp) does not support the Node.js version in use, usually because its V8/N-API bindings predate it.',
    advice:
      'Upgrade the addon to a release with prebuilt binaries for current Node.js, or replace it with a pure-JS alternative.',
  },
  'node-sass': {
    cause:
      'node-sass is deprecated and only ships bindings for the Node.js versions current at its release. It fails to compile on newer Node.js.',
    advice: 'Migrate to `sass` (Dart Sass), the official replacement.',
  },
  'engine-mismatch': {
    cause: 'A dependency declares an `engines.node` range that excludes the Node.js version used.',
    advice: 'Use a Node.js version inside the declared range, or upgrade the dependency.',
  },
  'openssl-legacy': {
    cause:
      'Node.js 17+ uses OpenSSL 3, which removed the MD4 hash that webpack 4 and similar tooling use for module ids (ERR_OSSL_EVP_UNSUPPORTED).',
    advice: 'Upgrade to webpack 5 (or react-scripts 5) to run on current Node.js.',
  },
  'modern-syntax': {
    cause:
      'Code or dependencies use JavaScript syntax or globals that the selected Node.js version does not support.',
    advice: 'Run on a newer Node.js release and declare it in `engines.node`.',
  },
  'missing-version': {
    cause:
      'A required version does not exist on the npm registry (it was never published, or was unpublished).',
    advice: 'Choose an existing version of the package.',
  },
  'unpublished-package': {
    cause: 'A dependency was removed from the npm registry entirely, so it cannot be installed.',
    advice:
      'Replace the package with a maintained alternative or vendor its code. RepoRevive cannot fix this automatically.',
  },
  'missing-module': {
    cause:
      'Code imports a package that package.json does not declare. It used to work because another dependency installed it transitively.',
    advice: 'Declare every directly imported package in package.json.',
  },
  'missing-binary': {
    cause:
      "An npm script calls a command-line tool that is not installed as a dependency (it was probably installed globally on the author's machine).",
    advice: 'Add the tool as a devDependency so `npm run` can find it.',
  },
  'types-incompatible': {
    cause:
      'A floating @types package resolved to a release written for a newer TypeScript than the project uses.',
    advice: 'Pin @types packages, or upgrade TypeScript.',
  },
  timeout: {
    cause:
      'The step exceeded its time limit. This can be an infinite watch mode, a hanging test, or a very slow build.',
    advice:
      'Make sure tests run once in CI mode (e.g. `jest --watchAll=false`) and do not wait for network services.',
  },
  network: {
    cause: 'Downloading dependencies failed because of a network error.',
    advice: 'Retry the resurrection. If it persists, a dependency host may be offline.',
  },
  'outdated-ci': {
    cause:
      'GitHub Actions workflows reference action versions that run on deprecated Node runtimes, retired runner images, or end-of-life Node.js versions.',
    advice: 'Keep actions on supported major versions and test on maintained Node.js releases.',
  },
  unknown: {
    cause: 'The step failed with an error that no built-in rule recognises.',
    advice:
      'Inspect the log excerpt. Configure an LLM provider to let RepoRevive attempt AI-assisted source fixes.',
  },
};

/** Issue kinds that RepoRevive never auto-fixes; they only produce suggestions. */
export const SUGGESTION_ONLY: ReadonlySet<IssueKind> = new Set(['unpublished-package', 'timeout', 'network']);
