import type { Issue, IssueKind, StepResult } from '../../core/types';

export interface PythonDiagnoseInput {
  result: Pick<StepResult, 'step' | 'status' | 'logTail' | 'command'>;
  manager: string;
  /** Top-level names of local packages/modules (to tell import-path from missing dependency). */
  localModules: Set<string>;
  declared: Set<string>;
}

/** Stdlib modules removed by Python 3.12/3.13 (PEP 594 and distutils). */
export const REMOVED_STDLIB = new Set([
  'distutils',
  'imp',
  'asyncore',
  'asynchat',
  'smtpd',
  'cgi',
  'cgitb',
  'telnetlib',
  'pipes',
  'crypt',
  'nntplib',
  'imghdr',
  'sndhdr',
  'aifc',
  'audioop',
  'chunk',
  'mailcap',
  'msilib',
  'nis',
  'ossaudiodev',
  'sunau',
  'spwd',
  'uu',
  'xdrlib',
  'lib2to3',
]);

function issue(
  kind: IssueKind,
  fingerprint: string,
  input: PythonDiagnoseInput,
  title: string,
  evidence: string,
  data: Record<string, string> = {},
  file?: string,
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
    },
  };
}

const excerpt = (log: string, re: RegExp): string => {
  const line = log.split(/\r?\n/).find((l) => re.test(l));
  return (line ?? '').trim();
};

/** Pure diagnosis of a failed Python step. Most specific kinds first; `unknown` is last. */
export function diagnosePythonOutput(input: PythonDiagnoseInput): Issue[] {
  const { result } = input;
  const log = result.logTail;
  const out: Issue[] = [];
  const push = (i: Issue) => {
    if (!out.some((o) => o.fingerprint === i.fingerprint)) out.push(i);
  };

  if (result.status === 'timeout') {
    push(issue('timeout', `timeout:${result.step}`, input, `The ${result.step} step timed out`, 'timeout'));
    return out;
  }

  // Lockfile problems (most specific for lock-based managers).
  const lockDrift =
    /pyproject\.toml changed significantly since poetry\.lock was last generated|poetry\.lock is not consistent with pyproject\.toml|Run [`'"]?poetry lock|The lockfile at [`'"]?uv\.lock[`'"]? needs to be updated|Pipfile\.lock .*out of date|Your Pipfile\.lock .*is out of date|Lock file .* out of date/i;
  if (lockDrift.test(log))
    push(
      issue(
        'lockfile-drift',
        'lockfile-drift',
        input,
        'Lockfile is out of date with the manifest',
        excerpt(log, lockDrift),
      ),
    );
  const lockBad =
    /lock file .*(?:not compatible|could not be parsed)|Unable to read .*lock|Failed to parse .*uv\.lock|invalid .*Pipfile\.lock/i;
  if (lockBad.test(log))
    push(
      issue(
        'lockfile-corrupt',
        'lockfile-corrupt',
        input,
        'Lockfile cannot be read by the current tool',
        excerpt(log, lockBad),
      ),
    );

  const requires =
    /Package ['"]?([\w.-]+)['"]? requires a different Python: ([\d.]+) not in ['"]([^'"]+)['"]|requires a different Python: ([\d.]+) not in ['"]([^'"]+)['"]|Python ([<>=!~,. \d*]+) (?:is|was) required|requires-python/i.exec(
      log,
    );
  if (requires)
    push(
      issue(
        'toolchain-mismatch',
        `toolchain-mismatch:${requires[1] ?? 'project'}`,
        input,
        `A package requires a different Python (${requires[3] ?? requires[5] ?? 'see log'})`,
        requires[0],
        {
          package: requires[1] ?? '',
          current: requires[2] ?? requires[4] ?? '',
          requires: requires[3] ?? requires[5] ?? '',
        },
      ),
    );

  const conflict =
    /ResolutionImpossible|conflicting dependencies|The conflict is caused by|Because [\w.-]+ depends on .* and .*, version solving failed|No solution found when resolving/i;
  if (conflict.test(log)) {
    const pkgs = [...log.matchAll(/^\s+([\w.-]+)(?:\s+[\d.]+)?\s+depends on\s+([\w.-]+)/gm)].flatMap((m) => [
      m[1]!,
      m[2]!,
    ]);
    push(
      issue(
        'dependency-conflict',
        'dependency-conflict',
        input,
        'Dependency constraints conflict',
        excerpt(log, conflict),
        { packages: [...new Set(pkgs)].join(',') },
      ),
    );
  }

  const noDist =
    /(?:No matching distribution found for|Could not find a version that satisfies the requirement) ([A-Za-z0-9._-]+)\s*(?:(==|>=|<=|~=|!=|<|>)\s*([\w.*]+))?/g;
  for (const m of log.matchAll(noDist)) {
    const name = m[1]!;
    push(
      issue(
        'missing-version',
        `missing-version:${name.toLowerCase()}`,
        input,
        `No installable release of ${name}${m[3] ? ` ${m[2]}${m[3]}` : ''}`,
        m[0],
        {
          package: name,
          op: m[2] ?? '',
          version: m[3] ?? '',
        },
      ),
    );
  }

  // Native/build-backend failures.
  const gcc =
    /error: command ['"]?(?:gcc|cc|x86_64-linux-gnu-gcc)['"]? failed|fatal error: [\w./+-]+\.h: No such file|Failed building (?:wheel|editable) for ([\w.-]+)|Microsoft Visual C\+\+|pg_config executable not found|mysql_config not found/i.exec(
      log,
    );
  if (gcc && !/ModuleNotFoundError: No module named ['"]distutils/.test(log))
    push(
      issue(
        'build-script-failure',
        `build-script-failure:${gcc[1] ?? 'native'}`,
        input,
        `A package failed to build${gcc[1] ? ` (${gcc[1]})` : ''}`,
        gcc[0],
        { package: gcc[1] ?? '' },
      ),
    );

  // Python 2 / legacy syntax.
  const legacy =
    /SyntaxError: Missing parentheses in call to 'print'|SyntaxError: invalid syntax|SyntaxError: Missing parentheses|except [\w.]+, \w+:|print >>/;
  const syntaxFile = /File "(?:\/workspace\/)?([^"]+\.py)", line (\d+)/.exec(log);
  if (/SyntaxError/.test(log) && legacy.test(log))
    push(
      issue(
        'legacy-syntax',
        `legacy-syntax:${syntaxFile?.[1] ?? 'unknown'}`,
        input,
        `Legacy (Python 2) syntax in ${syntaxFile?.[1] ?? 'source'}`,
        excerpt(log, /SyntaxError/),
        { file: syntaxFile?.[1] ?? '' },
        syntaxFile?.[1],
      ),
    );

  // Removed standard library.
  const modRemoved = /No module named ['"](\w+)(?:\.[\w.]+)?['"]/g;
  for (const m of log.matchAll(modRemoved)) {
    const top = m[1]!;
    if (REMOVED_STDLIB.has(top))
      push(
        issue(
          'removed-stdlib-api',
          `removed-stdlib:${top}`,
          input,
          `The standard-library module "${top}" no longer exists in this Python`,
          m[0],
          { module: top },
        ),
      );
  }
  const collAbc =
    /ImportError: cannot import name ['"](\w+)['"] from ['"]collections['"]|AttributeError: module ['"]collections['"] has no attribute ['"](\w+)['"]/.exec(
      log,
    );
  if (collAbc) {
    const f = [...log.matchAll(/File "(?:\/workspace\/)?([^"]+\.py)"/g)]
      .map((x) => x[1]!)
      .filter((p) => !p.startsWith('/'))
      .pop();
    push(
      issue(
        'removed-stdlib-api',
        `removed-stdlib:collections.${collAbc[1] ?? collAbc[2]}`,
        input,
        `collections.${collAbc[1] ?? collAbc[2]} moved to collections.abc`,
        collAbc[0],
        { module: 'collections', name: collAbc[1] ?? collAbc[2] ?? '', file: f ?? '' },
        f,
      ),
    );
  }
  const attrRemoved = /AttributeError: module ['"](\w+)['"] has no attribute ['"](\w+)['"]/.exec(log);
  if (attrRemoved && attrRemoved[1] !== 'collections')
    push(
      issue(
        'removed-stdlib-api',
        `removed-stdlib:${attrRemoved[1]}.${attrRemoved[2]}`,
        input,
        `${attrRemoved[1]}.${attrRemoved[2]} does not exist in this Python`,
        attrRemoved[0],
        { module: attrRemoved[1]!, name: attrRemoved[2]! },
      ),
    );

  // Missing modules / import path.
  for (const m of log.matchAll(/ModuleNotFoundError: No module named ['"]([\w.]+)['"]/g)) {
    const mod = m[1]!;
    const top = mod.split('.')[0]!;
    if (REMOVED_STDLIB.has(top)) continue;
    if (input.localModules.has(top)) {
      push(
        issue('import-path', `import-path:${top}`, input, `Cannot import the project module "${top}"`, m[0], {
          module: top,
        }),
      );
    } else {
      push(
        issue('missing-module', `missing-module:${top}`, input, `Missing Python module "${top}"`, m[0], {
          module: top,
        }),
      );
    }
  }
  const cannotImport =
    /ImportError while importing test module|ImportPathMismatchError|import file mismatch/i;
  if (cannotImport.test(log) && !out.some((o) => o.kind === 'import-path' || o.kind === 'missing-module'))
    push(
      issue(
        'import-path',
        'import-path:tests',
        input,
        'Tests cannot import the project',
        excerpt(log, cannotImport),
        { module: '' },
      ),
    );

  const net =
    /Temporary failure in name resolution|Connection (?:refused|reset)|Read timed out|ConnectTimeoutError|Max retries exceeded/i;
  if (out.length === 0 && net.test(log))
    push(
      issue('network', 'network', input, 'Network error while contacting a package index', excerpt(log, net)),
    );

  if (out.length === 0) {
    if (result.step === 'build')
      push(
        issue(
          'build-failure',
          'build-failure',
          input,
          'Byte-compiling the sources failed',
          excerpt(log, /Error|error/),
        ),
      );
    else if (result.step === 'test')
      push(issue('test-failure', 'test-failure', input, 'Tests failed', excerpt(log, /FAILED|failed|Error/)));
    else
      push(
        issue(
          'unknown',
          'unknown:install',
          input,
          'Dependency installation failed',
          excerpt(log, /ERROR|error/),
        ),
      );
  }
  return out;
}
