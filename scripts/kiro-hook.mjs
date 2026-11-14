#!/usr/bin/env node
// Helper invoked by Kiro hooks in .kiro/hooks. Reads the hook payload (JSON) from stdin.
// Usage: node scripts/kiro-hook.mjs <format|lint|test|guard-push>
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

/** Collect every string value in the payload (paths/commands may sit under different keys). */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

function projectFiles(payload, exts) {
  const files = new Set();
  for (const s of strings(payload)) {
    if (s.length > 500 || !exts.some((e) => s.endsWith(e))) continue;
    const abs = path.resolve(root, s);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules'))
      continue;
    files.add(rel);
  }
  return [...files];
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status ?? 1;
}

const raw = await readStdin();
let payload = {};
try {
  payload = raw ? JSON.parse(raw) : {};
} catch {
  payload = { raw };
}

switch (mode) {
  case 'format': {
    const files = projectFiles(payload, ['.ts', '.tsx', '.mjs', '.css', '.md', '.json']);
    if (files.length) run('npx', ['prettier', '--write', '--log-level', 'warn', ...files]);
    break;
  }
  case 'lint': {
    const files = projectFiles(payload, ['.ts', '.tsx']);
    if (files.length) process.exit(run('npx', ['eslint', '--fix', ...files]) === 0 ? 0 : 1);
    break;
  }
  case 'test': {
    const files = projectFiles(payload, ['.ts']);
    if (files.length) process.exit(run('npx', ['vitest', 'related', '--run', ...files]) === 0 ? 0 : 1);
    break;
  }
  case 'guard-push': {
    // Product rule: never push to the original repository without explicit user authorization.
    const text = strings(payload).join('\n');
    if (/\bgit\s+push\b/.test(text) || /\bgh\s+(pr|repo)\s+(create|fork)\b/.test(text)) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'ask',
            permissionDecisionReason: 'RepoRevive policy: pushing requires explicit user authorization.',
          },
        }),
      );
    }
    break;
  }
  default:
    console.error(`unknown hook mode: ${mode}`);
    process.exit(1);
}
