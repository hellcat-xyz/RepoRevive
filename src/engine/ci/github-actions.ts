import { parseAllDocuments } from 'yaml';

/**
 * Static analysis and minimal line-level fixes for GitHub Actions workflows. Line-level edits keep
 * comments and formatting intact, so the resulting diff is small and reviewable.
 */

export interface CiFinding {
  rule: 'action-version' | 'retired-runner' | 'eol-node';
  line: number;
  message: string;
}

const ACTIONS = ['checkout', 'setup-node', 'cache', 'upload-artifact', 'download-artifact'];
const ACTION_RE = new RegExp(
  String.raw`(uses:\s*["']?actions/(${ACTIONS.join('|')}))@(v[1-3](?:\.\d+){0,2}|master|main)\b`,
  'g',
);

const RUNNERS: [RegExp, string][] = [
  [/\bubuntu-(?:14|16|18|20)\.04\b/g, 'ubuntu-latest'],
  [/\bmacos-(?:10\.1[0-5]|11|12)\b/g, 'macos-latest'],
  [/\bwindows-(?:2016|2019)\b/g, 'windows-latest'],
];

const NODE_KEY = String.raw`(?:node-version|node_version|node|nodejs|node-versions)`;
const SCALAR_RE = new RegExp(
  String.raw`^(\s*-?\s*${NODE_KEY}\s*:\s*)(["']?)(v?\d+(?:\.(?:\d+|x))*)(\2)(\s*(?:#.*)?)$`,
);
const FLOW_RE = new RegExp(String.raw`^(\s*-?\s*${NODE_KEY}\s*:\s*)\[([^\]]*)\](\s*(?:#.*)?)$`);
const BLOCK_KEY_RE = new RegExp(String.raw`^(\s*-?\s*)${NODE_KEY}\s*:\s*(?:#.*)?$`);
const BLOCK_ITEM_RE = /^(\s*-\s*)(["']?)(v?\d+(?:\.(?:\d+|x))*)(\2)(\s*(?:#.*)?)$/;

function majorOf(v: string): number | null {
  const m = /^v?(\d+)/.exec(v.trim());
  return m ? Number(m[1]) : null;
}

function isEol(major: number, target: number): boolean {
  return major < 18 && major !== target;
}

function styled(sample: string, target: number): string {
  const s = sample.trim();
  const quote = /^["']/.test(s) ? s[0]! : '';
  const inner = s.replace(/^["']|["']$/g, '');
  const suffix = /\.x$/.test(inner) ? '.x' : '';
  return `${quote}${target}${suffix}${quote}`;
}

function fixFlowList(body: string, target: number): string | null {
  const items = body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length || items.some((i) => majorOf(i.replace(/["']/g, '')) === null)) return null;
  const keep = items.filter((i) => !isEol(majorOf(i.replace(/["']/g, ''))!, target));
  if (keep.length === items.length) return null;
  const targetItem = styled(items[0]!, target);
  const out = [...keep];
  if (!out.some((i) => majorOf(i.replace(/["']/g, '')) === target)) out.unshift(targetItem);
  out.sort((a, b) => majorOf(a.replace(/["']/g, ''))! - majorOf(b.replace(/["']/g, ''))!);
  return out.join(', ');
}

export interface CiFixResult {
  text: string;
  findings: CiFinding[];
}

/** Scan (and compute the fixed text for) one workflow. `target` is the verified Node major. */
export function analyzeWorkflow(text: string, target: number): CiFixResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const findings: CiFinding[] = [];
  let inBlockList = false;
  let blockHasTarget = false;
  let blockIndent = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (/^\s*#/.test(line)) continue;

    line = line.replace(ACTION_RE, (_m, prefix: string, name: string, ver: string) => {
      findings.push({
        rule: 'action-version',
        line: i + 1,
        message: `actions/${name}@${ver} is deprecated; use @v4.`,
      });
      return `${prefix}@v4`;
    });

    for (const [re, to] of RUNNERS) {
      line = line.replace(re, (m) => {
        findings.push({
          rule: 'retired-runner',
          line: i + 1,
          message: `Runner image ${m} has been retired by GitHub.`,
        });
        return to;
      });
    }
    // Collapse duplicates produced inside flow lists, e.g. [ubuntu-latest, ubuntu-latest].
    line = line.replace(/\[([^\]]*)\]/, (whole, body: string) => {
      const items = body.split(',').map((s) => s.trim());
      const unique = items.filter((v, idx) => items.indexOf(v) === idx);
      return unique.length === items.length ? whole : `[${unique.join(', ')}]`;
    });

    if (inBlockList) {
      const item = BLOCK_ITEM_RE.exec(line);
      if (item && item[1]!.startsWith(blockIndent)) {
        const major = majorOf(item[3]!);
        if (major !== null && isEol(major, target)) {
          findings.push({ rule: 'eol-node', line: i + 1, message: `Node.js ${item[3]} is end-of-life.` });
          if (blockHasTarget) {
            lines.splice(i, 1);
            i--;
            continue;
          }
          line = `${item[1]}${styled(`${item[2]}${item[3]}${item[4]}`, target)}${item[5]}`;
          blockHasTarget = true;
        }
        lines[i] = line;
        continue;
      }
      inBlockList = false;
    }

    const flow = FLOW_RE.exec(line);
    const scalar = SCALAR_RE.exec(line);
    if (flow) {
      const fixed = fixFlowList(flow[2]!, target);
      if (fixed !== null) {
        findings.push({
          rule: 'eol-node',
          line: i + 1,
          message: `Node.js matrix [${flow[2]!.trim()}] includes end-of-life versions.`,
        });
        line = `${flow[1]}[${fixed}]${flow[3]}`;
      }
    } else if (scalar) {
      const major = majorOf(scalar[3]!);
      if (major !== null && isEol(major, target)) {
        findings.push({ rule: 'eol-node', line: i + 1, message: `Node.js ${scalar[3]} is end-of-life.` });
        line = `${scalar[1]}${styled(`${scalar[2]}${scalar[3]}${scalar[4]}`, target)}${scalar[5]}`;
      }
    } else if (BLOCK_KEY_RE.test(line)) {
      inBlockList = true;
      blockIndent = /^\s*/.exec(line)![0];
      // Look ahead: if the verified runtime is already listed, EOL entries are simply removed.
      blockHasTarget = false;
      for (let j = i + 1; j < lines.length; j++) {
        const it = BLOCK_ITEM_RE.exec(lines[j]!);
        if (!it || !it[1]!.startsWith(blockIndent)) break;
        if (majorOf(it[3]!) === target) blockHasTarget = true;
      }
    }
    lines[i] = line;
  }
  return { text: lines.join(eol), findings };
}

export function isValidYaml(text: string): boolean {
  try {
    return parseAllDocuments(text).every((d) => !('errors' in d) || d.errors.length === 0);
  } catch {
    return false;
  }
}
