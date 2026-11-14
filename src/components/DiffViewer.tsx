'use client';

import { useMemo, useState } from 'react';

interface DiffFile {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  lines: string[];
  additions: number;
  deletions: number;
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (m) {
      cur = { path: m[2]!, status: 'modified', lines: [], additions: 0, deletions: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    else {
      if (line.startsWith('+')) cur.additions++;
      else if (line.startsWith('-')) cur.deletions++;
      cur.lines.push(line);
    }
  }
  return files;
}

const LARGE = 400;

function FileBlock({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const badge = {
    added: 'text-ecto-300 bg-ecto-400/10',
    deleted: 'text-rose-300 bg-rose-400/10',
    modified: 'text-spirit-300 bg-spirit-400/10',
  }[file.status];
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-crypt-950/70">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={`text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            ▸
          </span>
          <span className="truncate font-mono text-[13px] text-zinc-200">{file.path}</span>
          <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${badge}`}>
            {file.status}
          </span>
        </span>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-ecto-400">+{file.additions}</span>{' '}
          <span className="text-rose-400">-{file.deletions}</span>
        </span>
      </button>
      {open && (
        <div className="max-h-[480px] overflow-auto border-t border-white/[0.06]">
          <pre className="min-w-max py-2 font-mono text-[12px] leading-[1.55]">
            {file.lines.map((l, i) => {
              const cls = l.startsWith('+')
                ? 'bg-ecto-400/[0.08] text-ecto-200'
                : l.startsWith('-')
                  ? 'bg-rose-400/[0.08] text-rose-200'
                  : l.startsWith('@@')
                    ? 'text-spirit-300/80 bg-spirit-400/[0.05]'
                    : 'text-zinc-400';
              return (
                <div key={i} className={`px-4 ${cls}`}>
                  {l || ' '}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}

export function DiffViewer({ diff, emptyLabel = 'No changes.' }: { diff: string; emptyLabel?: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!files.length) return <p className="text-sm text-zinc-500">{emptyLabel}</p>;
  return (
    <div className="space-y-3">
      {files.map((f) => (
        <FileBlock key={f.path} file={f} defaultOpen={f.lines.length < LARGE && !/lock/.test(f.path)} />
      ))}
    </div>
  );
}
