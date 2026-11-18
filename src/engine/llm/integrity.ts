/**
 * Guards against "fixes" that make a step pass by weakening the project: fewer tests, skipped tests,
 * neutralised scripts, or newly introduced dangerous APIs. Pure; used on every AI-generated file.
 */

const TEST_CASE_RE =
  /\b(?:it|test|describe)\s*(?:\.\w+)?\s*\(|\bdef test_\w*|#\[(?:tokio::)?test\]|\bfunc Test\w+\s*\(|@Test\b|\bfn test_\w+/g;
const SKIP_RE =
  /\.skip\b|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\(|#\[ignore\]|\bt\.Skip(?:f|Now)?\(|@Disabled\b|@Ignore\b/g;
const FORCE_PASS_RE = /\|\|\s*true\b|;\s*true\s*$|\bexit\s+0\b|--passWithNoTests|continue-on-error/gm;
const DANGEROUS_RE =
  /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\beval\s*\(|\bnew Function\s*\(|process\.env\.\w*(?:TOKEN|SECRET|PASSWORD|API_?KEY)\w*|os\.system\s*\(|subprocess\.(?:run|Popen|call)\s*\(/g;

const count = (re: RegExp, text: string): number => text.match(re)?.length ?? 0;
const isTestFile = (p: string) =>
  /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|Tests?\.java$|(?:^|\/)tests\/[^/]+\.rs$/i.test(
    p,
  );

function scriptsOf(raw: string | null): Record<string, string> | null {
  if (raw === null) return null;
  try {
    const s = (JSON.parse(raw) as { scripts?: unknown }).scripts;
    return s && typeof s === 'object' ? (s as Record<string, string>) : {};
  } catch {
    return null;
  }
}

/** Returns why an edit must be rejected, or null when it is acceptable. */
export function checkEditIntegrity(path: string, before: string | null, after: string): string | null {
  if (before !== null && before.trim() !== '' && after.trim() === '') return `Edit would empty ${path}.`;

  if (before !== null) {
    if (count(SKIP_RE, after) > count(SKIP_RE, before)) return `Edit skips or disables tests in ${path}.`;
    if (count(FORCE_PASS_RE, after) > count(FORCE_PASS_RE, before))
      return `Edit forces a step to pass (|| true, exit 0, passWithNoTests) in ${path}.`;
    if (count(DANGEROUS_RE, after) > count(DANGEROUS_RE, before))
      return `Edit introduces process execution, eval or secret access in ${path}.`;
    const casesBefore = count(TEST_CASE_RE, before);
    if (count(TEST_CASE_RE, after) < casesBefore && (isTestFile(path) || casesBefore > 0))
      return `Edit removes test cases from ${path}.`;
  } else {
    if (count(SKIP_RE, after) > 0) return `New file ${path} skips or disables tests.`;
    if (count(FORCE_PASS_RE, after) > 0) return `New file ${path} forces a step to pass.`;
    if (count(DANGEROUS_RE, after) > 0)
      return `New file ${path} uses process execution, eval or secret access.`;
  }

  if (/(?:^|\/)package\.json$/.test(path)) {
    const a = scriptsOf(before);
    const b = scriptsOf(after);
    if (a && b) {
      for (const name of Object.keys(a))
        if (!(name in b)) return `Edit removes the "${name}" script from ${path}.`;
      for (const name of ['test', 'build']) {
        if (a[name] !== undefined && b[name] !== a[name] && /^\s*(?:echo|true|exit)\b/.test(b[name] ?? ''))
          return `Edit replaces the "${name}" script in ${path} with a no-op.`;
      }
    }
  }
  return null;
}
