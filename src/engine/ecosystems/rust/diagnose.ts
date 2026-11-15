import type { Issue, IssueKind, StepResult } from '../../core/types';

export interface RustDiagnoseInput {
  result: Pick<StepResult, 'step' | 'status' | 'logTail' | 'command'>;
}

function mk(
  input: RustDiagnoseInput,
  kind: IssueKind,
  fingerprint: string,
  title: string,
  evidence: string,
  data: Record<string, string> = {},
  file?: string,
  pkg?: string,
): Issue {
  return {
    kind,
    fingerprint,
    step: input.result.step,
    severity: 'error',
    title,
    evidence: evidence.slice(0, 600),
    data,
    diagnostic: {
      category: kind,
      message: title,
      command: input.result.command,
      ...(file ? { file } : {}),
      ...(pkg ? { package: pkg } : {}),
    },
  };
}

const line = (log: string, re: RegExp) => (log.split(/\r?\n/).find((l) => re.test(l)) ?? '').trim();

/** Workspace-aware: names the failing package (`could not compile `x``) so reports can be per-package. */
export function failingPackages(log: string): string[] {
  return [...new Set([...log.matchAll(/could not compile `([\w-]+)`/g)].map((m) => m[1]!))];
}

/** Pure diagnosis of a failed Cargo step. */
export function diagnoseCargoOutput(input: RustDiagnoseInput): Issue[] {
  const { result } = input;
  const log = result.logTail;
  const out: Issue[] = [];
  const push = (i: Issue) => {
    if (!out.some((o) => o.fingerprint === i.fingerprint)) out.push(i);
  };
  if (result.status === 'timeout') {
    push(mk(input, 'timeout', `timeout:${result.step}`, `The ${result.step} step timed out`, 'timeout'));
    return out;
  }

  if (
    /the lock file .* needs to be updated but --locked was passed|Cargo\.lock needs to be updated/i.test(log)
  )
    push(
      mk(
        input,
        'lockfile-drift',
        'lockfile-drift',
        'Cargo.lock is out of date with Cargo.toml',
        line(log, /lock file|Cargo\.lock/i),
      ),
    );
  if (
    /failed to parse lock file|lock file version `?\d+`? was found, but this version of Cargo does not understand/i.test(
      log,
    )
  ) {
    const newer = /does not understand/.test(log);
    push(
      newer
        ? mk(
            input,
            'toolchain-mismatch',
            'toolchain-mismatch:lockfile',
            'Cargo.lock uses a newer format than this Cargo understands',
            line(log, /lock file/i),
            { required: '1.78' },
          )
        : mk(
            input,
            'lockfile-corrupt',
            'lockfile-corrupt',
            'Cargo.lock cannot be parsed',
            line(log, /failed to parse lock file/i),
          ),
    );
  }

  const rustc =
    /(?:package|crate) `([\w.-]+)(?: v?([\d.]+))?` cannot be built because it requires rustc ([\d.]+) or newer, while the currently active rustc version is ([\d.]+)|requires rustc ([\d.]+) or newer/i.exec(
      log,
    );
  if (rustc)
    push(
      mk(
        input,
        'toolchain-mismatch',
        `toolchain-mismatch:${rustc[1] ?? 'rustc'}`,
        `A crate needs a newer Rust compiler (${rustc[3] ?? rustc[5]})`,
        rustc[0],
        { required: rustc[3] ?? rustc[5] ?? '', package: rustc[1] ?? '' },
      ),
    );
  const edition =
    /feature `edition(\d{4})` is required|edition `?(\d{4})`? is (?:not supported|unstable)|unknown edition `?(\d{4})`?|this version of Cargo is older than the `(\d{4})` edition/i.exec(
      log,
    );
  if (edition) {
    const e = edition[1] ?? edition[2] ?? edition[3] ?? edition[4] ?? '';
    push(
      mk(
        input,
        'unsupported-edition',
        `unsupported-edition:${e}`,
        `Rust edition ${e} is not supported by this compiler`,
        edition[0],
        { edition: e },
      ),
    );
  }
  if (
    /`#!\[feature\]` may not be used on the stable release channel|requires the nightly|only accepted on the nightly/i.test(
      log,
    )
  )
    push(
      mk(
        input,
        'toolchain-mismatch',
        'toolchain-mismatch:nightly',
        'The code needs the nightly toolchain, which is not available',
        line(log, /nightly|feature/i),
        { required: 'nightly' },
      ),
    );

  const noPkg =
    /no matching package named `([\w-]+)` found|failed to select a version for the requirement `([\w-]+) = "?([^"`]+)"?`|failed to select a version for `([\w-]+)`/i.exec(
      log,
    );
  if (noPkg) {
    const name = noPkg[1] ?? noPkg[2] ?? noPkg[4]!;
    const yanked = /yanked/i.test(log);
    push(
      mk(
        input,
        'missing-version',
        `missing-version:${name}`,
        `No usable release of crate "${name}"${noPkg[3] ? ` for ${noPkg[3]}` : ''}${yanked ? ' (yanked)' : ''}`,
        noPkg[0],
        { package: name, requirement: noPkg[3] ?? '' },
      ),
    );
  }
  const feat =
    /package `([\w-]+)` depends on `([\w-]+)`(?: with features?: `([^`]+)`)? but `\2` does not have these features/i.exec(
      log,
    ) ?? /does not have feature `([\w-]+)`|unknown feature `([\w-]+)`/i.exec(log);
  if (feat) {
    const features = feat[3] ?? feat[1] ?? feat[2] ?? '';
    push(
      mk(
        input,
        'missing-feature',
        `missing-feature:${feat[2] ?? ''}:${features}`,
        `A declared Cargo feature does not exist (${features})`,
        feat[0],
        { package: feat[2] ?? '', feature: features },
      ),
    );
  }
  if (
    /failed to select a version for `[\w-]+`.*\n.*conflicts with a previous package|links to the native library|versions that meet the requirements .* are:/is.test(
      log,
    ) &&
    !out.some((o) => o.kind === 'missing-version')
  )
    push(
      mk(
        input,
        'dependency-conflict',
        'dependency-conflict',
        'Dependency requirements conflict',
        line(log, /conflict|links to/i),
      ),
    );

  const buildScript = /failed to run custom build command for `([\w-]+) v?([\d.]+)?/i.exec(log);
  if (buildScript)
    push(
      mk(
        input,
        'build-script-failure',
        `build-script-failure:${buildScript[1]}`,
        `Build script of "${buildScript[1]}" failed`,
        line(log, /pkg-config|openssl|could not find|failed to run/i) || buildScript[0],
        { package: buildScript[1]! },
        undefined,
        buildScript[1],
      ),
    );

  for (const m of log.matchAll(
    /error\[E0(?:432|433)\]: (?:unresolved import|failed to resolve).*?`([\w]+)`/g,
  )) {
    const crate = m[1]!;
    if (!['crate', 'self', 'super', 'std', 'core', 'alloc'].includes(crate))
      push(
        mk(
          input,
          'missing-module',
          `missing-module:${crate}`,
          `Unresolved crate or module "${crate}"`,
          m[0],
          { crate },
        ),
      );
  }
  const deny =
    /error: failed to download|error: failed to get|Connection (?:reset|refused)|spurious network error|Could not resolve host|SSL connect error/i;
  if (out.length === 0 && deny.test(log))
    push(
      mk(input, 'network', 'network', 'Network error while contacting the crate registry', line(log, deny)),
    );

  if (out.length === 0) {
    if (result.step === 'test' && /test result: FAILED|failures:/.test(log))
      push(mk(input, 'test-failure', 'test-failure', 'Tests failed', line(log, /FAILED|failed/)));
    else if (/error\[E\d+\]|error: could not compile/.test(log)) {
      const loc = /-->\s+([\w./-]+\.rs):(\d+):(\d+)/.exec(log);
      for (const pkg of failingPackages(log)
        .slice(0, 3)
        .concat(failingPackages(log).length ? [] : [''])) {
        push(
          mk(
            input,
            'compile-error',
            `compile-error:${pkg || 'crate'}:${loc?.[1] ?? ''}`,
            `Compilation failed${pkg ? ` in package "${pkg}"` : ''}`,
            line(log, /^error/),
            { package: pkg, file: loc?.[1] ?? '' },
            loc?.[1],
            pkg || undefined,
          ),
        );
      }
    } else if (result.step === 'install')
      push(mk(input, 'unknown', 'unknown:install', 'cargo fetch failed', line(log, /error/i)));
    else if (result.step === 'build')
      push(mk(input, 'build-failure', 'build-failure', 'cargo check failed', line(log, /error/i)));
    else push(mk(input, 'test-failure', 'test-failure', 'cargo test failed', line(log, /error|FAILED/i)));
  }
  return out;
}
