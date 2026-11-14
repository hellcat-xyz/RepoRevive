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
  'lifecycle-script-failure': {
    cause:
      'An npm lifecycle script (preinstall, install, postinstall, or prepare) exited with an error, which makes `npm ci` / `npm install` fail.',
    advice:
      'Read the command and file named in the diagnosis, fix the script, and avoid lifecycle scripts that need network access or generated files.',
  },
  'broken-upstream-resource': {
    cause:
      'A script downloads a file from an external URL that now answers 404 or 410. The upstream project usually moved, renamed, or deleted it after this repository was last updated, and the URL points at a floating branch such as `main`.',
    advice:
      'Vendor the downloaded files into the repository or pin the URL to a commit SHA so builds stop depending on a moving upstream branch.',
  },
  'missing-file': {
    cause:
      'A script or tool tried to read a file or directory that does not exist (ENOENT). It may be a generated asset, an ignored file, or a path that moved.',
    advice: 'Commit the missing file, generate it in an earlier script, or correct the path.',
  },
  'missing-script': {
    cause: 'A command ran `npm run <name>` but package.json defines no script with that name.',
    advice: 'Add the script to package.json or fix the name in the calling script.',
  },
  'lockfile-corrupt': {
    cause:
      'package-lock.json cannot be parsed or fails integrity checks (EJSONPARSE, EINTEGRITY, merge-conflict markers).',
    advice: 'Delete the lockfile and run `npm install` to create a clean one, then review the diff.',
  },
  'typescript-error': {
    cause:
      'The TypeScript compiler reported type errors. The code and its dependencies (or the compiler version) no longer agree.',
    advice:
      'Fix the reported errors, or pin the TypeScript and @types versions the project was written against.',
  },
  'dependency-api-change': {
    cause:
      'Code uses an export or function that the installed version of a dependency no longer provides, usually after a major upgrade.',
    advice:
      'Pin the dependency to the major version the code was written for, or port the code to the new API.',
  },
  'build-failure': {
    cause: 'The build script failed with an error that no more specific rule recognises.',
    advice: 'Inspect the log excerpt for the first error and fix that first.',
  },
  'test-failure': {
    cause:
      'The test suite ran and reported failing tests. RepoRevive never removes or skips tests to make them pass.',
    advice: 'Review the failing tests: they may reveal real regressions from dependency drift.',
  },
  unknown: {
    cause: 'The step failed with an error that no built-in rule recognises.',
    advice:
      'Inspect the log excerpt. Configure an LLM provider to let RepoRevive attempt AI-assisted source fixes.',
  },
};

/** Issue kinds that RepoRevive never auto-fixes; they only produce suggestions. */
export const SUGGESTION_ONLY: ReadonlySet<IssueKind> = new Set(['unpublished-package', 'timeout', 'network']);
