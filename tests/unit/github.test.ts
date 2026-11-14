import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseGitHubUrl } from '@/lib/github';

const ownerArb = fc.stringMatching(/^[A-Za-z0-9]{1,10}(?:-[A-Za-z0-9]{1,8}){0,2}$/);
const repoArb = fc
  .stringMatching(/^[A-Za-z0-9._-]{1,40}$/)
  .filter((s) => s !== '.' && s !== '..' && !s.toLowerCase().endsWith('.git'));

describe('parseGitHubUrl', () => {
  it.each([
    ['https://github.com/expressjs/express', 'expressjs', 'express'],
    ['https://github.com/expressjs/express.git', 'expressjs', 'express'],
    ['https://www.github.com/expressjs/express/', 'expressjs', 'express'],
    ['github.com/facebook/react/tree/main/packages', 'facebook', 'react'],
    ['  http://github.com/a-b/c.d_e  ', 'a-b', 'c.d_e'],
  ])('accepts %s', (input, owner, name) => {
    const r = parseGitHubUrl(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repo).toEqual({ owner, name, url: `https://github.com/${owner}/${name}` });
  });

  it.each([
    '',
    'https://gitlab.com/a/b',
    'https://github.com/onlyowner',
    'https://user:pass@github.com/a/b',
    'https://github.com:8443/a/b',
    'ftp://github.com/a/b',
    'https://github.com/-bad/repo',
    'https://github.com/a/..',
    'https://github.evil.com/a/b',
    'javascript:alert(1)',
    'https://github.com/a/b;rm -rf',
  ])('rejects %s', (input) => {
    expect(parseGitHubUrl(input).ok).toBe(false);
  });

  it('P7: round-trips any valid owner/repo with decorations', () => {
    fc.assert(
      fc.property(
        ownerArb,
        repoArb,
        fc.constantFrom('', '.git', '/', '/tree/main', '/issues'),
        fc.constantFrom('https://', 'http://', 'https://www.', ''),
        (owner, name, suffix, prefix) => {
          const r = parseGitHubUrl(`${prefix}github.com/${owner}/${name}${suffix}`);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.repo.owner).toBe(owner);
            expect(r.repo.name).toBe(name);
          }
        },
      ),
    );
  });

  it('never produces a URL containing characters outside the allow-list', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => {
        const r = parseGitHubUrl(`https://github.com/${s}`);
        if (r.ok) expect(r.repo.url).toMatch(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
      }),
    );
  });
});
