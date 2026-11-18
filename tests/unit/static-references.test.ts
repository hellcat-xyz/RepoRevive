import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from '@/engine/core/workspace';
import { detectEcosystems } from '@/engine/ecosystems';
import {
  extractCssReferences,
  extractHtmlReferences,
  findBrokenReferences,
  localTarget,
  resolveExact,
  rewriteReference,
} from '@/engine/ecosystems/static/references';
import { staticEcosystem } from '@/engine/ecosystems/static';
import { makeRepo } from '../helpers/fake-world';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function open(files: Record<string, string>) {
  const repo = await makeRepo(files);
  cleanups.push(repo.cleanup);
  return Workspace.open(repo.repoDir);
}

describe('static site references', () => {
  it('extracts local references, ignoring comments, inline scripts, and non-file links', () => {
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="styles.css"><link rel="canonical" href="https://x.dev/">
      </head><body>
      <!-- <img src="ghost.png"> -->
      <img src='pic/a.png'><a href="#top">top</a><a href="mailto:a@b.c">m</a>
      <script src=app.js></script><script>var s = '<img src="inline.png">';</script>
      <video poster="p.jpg" src="v.mp4"></video></body></html>`;
    const refs = extractHtmlReferences(html).map((r) => `${r.tag}:${r.attr}:${r.ref}`);
    expect(refs).toContain('link:href:styles.css');
    expect(refs).toContain('img:src:pic/a.png');
    expect(refs).toContain('script:src:app.js');
    expect(refs).toContain('video:poster:p.jpg');
    expect(refs.join(' ')).not.toContain('ghost.png');
    expect(refs.join(' ')).not.toContain('inline.png');
    expect(refs).not.toContain('link:href:https://x.dev/');
  });

  it('reports exact value spans so edits only touch the reference text', () => {
    const html = '<img alt="x" src="Pic/A.png"><a href="Pic/A.png">';
    for (const r of extractHtmlReferences(html)) expect(html.slice(r.start, r.end)).toBe(r.ref);
    const css = "a{background:url('img/Bg.png')} @import 'base.css'; /* url(x.png) */";
    const refs = extractCssReferences(css);
    expect(refs.map((r) => r.ref)).toEqual(['img/Bg.png', 'base.css']);
    for (const r of refs) expect(css.slice(r.start, r.end)).toBe(r.ref);
  });

  it('resolves references relative to the file, decodes them, and skips non-local ones', () => {
    expect(localTarget('index.html', 'styles.css')).toBe('styles.css');
    expect(localTarget('pages/a.html', '../img/x.png?v=2#h')).toBe('img/x.png');
    expect(localTarget('pages/a.html', '/img/x.png')).toBe('img/x.png');
    expect(localTarget('index.html', 'my%20pic.png')).toBe('my pic.png');
    expect(localTarget('index.html', 'pic/')).toBe('pic');
    for (const r of [
      '',
      '#x',
      'https://a.b/c',
      '//cdn.x/y.js',
      'data:image/png;base64,AA',
      '{{ url }}',
      '../../up.png',
    ])
      expect(localTarget('index.html', r)).toBeNull();
  });

  it('checks case exactly even on case-insensitive file systems', async () => {
    const ws = await open({ 'index.html': '', 'img/Logo.PNG': '' });
    const cache = new Map();
    expect(await resolveExact(ws, 'img/Logo.PNG', cache)).toEqual({ state: 'exact' });
    expect(await resolveExact(ws, 'IMG/logo.png', cache)).toEqual({
      state: 'case',
      corrected: 'img/Logo.PNG',
    });
    expect(await resolveExact(ws, 'img/other.png', cache)).toEqual({ state: 'missing' });
  });

  it('P: a rewritten reference resolves exactly to the corrected path', () => {
    const seg = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,6}$/);
    fc.assert(
      fc.property(
        fc.array(seg, { maxLength: 2 }),
        fc.array(seg, { minLength: 1, maxLength: 3 }),
        fc.constantFrom('', './', '/'),
        fc.constantFrom('', '?v=1', '#top'),
        (dirParts, targetParts, style, suffix) => {
          const file = [...dirParts, 'page.html'].join('/');
          const corrected = targetParts.join('/') + '.png';
          const original = `${style}${corrected.toLowerCase()}${suffix}`;
          const rewritten = rewriteReference(file, original, corrected);
          expect(localTarget(file, rewritten)).toBe(corrected);
          expect(rewritten.endsWith(suffix)).toBe(true);
        },
      ),
    );
  });

  it('finds broken references with a letter-case suggestion only when a file matches', async () => {
    const ws = await open({
      'index.html':
        '<link rel="stylesheet" href="Styles.css"><script src="missing.js"></script><img src="pic/a.png">',
      'styles.css': "a{background:url('pic/B.png')}",
      'pic/a.png': '',
      'pic/b.png': '',
    });
    const broken = await findBrokenReferences(ws);
    expect(broken.map((b) => [b.file, b.ref, b.suggestion])).toEqual([
      ['index.html', 'Styles.css', 'styles.css'],
      ['index.html', 'missing.js', undefined],
      ['styles.css', 'pic/B.png', 'pic/b.png'],
    ]);
  });

  it('is a fallback: any ecosystem with a manifest wins over index.html', async () => {
    const ws = await open({ 'index.html': '<html></html>', 'package.json': '{"name":"x"}' });
    expect((await detectEcosystems(ws)).selected?.ecosystem.id).toBe('npm');
    const only = await open({ 'index.html': '<html></html>', 'script.js': '' });
    const d = await detectEcosystems(only);
    expect(d.selected?.ecosystem.id).toBe('static');
    expect(d.ambiguous).toBe(false);
    expect(await staticEcosystem.analyze(only)).toMatchObject({
      ecosystem: 'static',
      packageManager: 'none',
    });
  });
});
