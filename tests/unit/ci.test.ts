import { describe, expect, it } from 'vitest';
import { analyzeWorkflow, isValidYaml } from '@/engine/ci/github-actions';

const OLD = `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-18.04  # old runner
    strategy:
      matrix:
        node-version: [8.x, 10.x, 12.x]
        os: [ubuntu-16.04, ubuntu-18.04]
    steps:
      # uses: actions/checkout@v1 (comment is untouched)
      - uses: actions/checkout@v2
      - name: Use Node.js
        uses: actions/setup-node@v1
        with:
          node-version: \${{ matrix.node-version }}
      - uses: actions/cache@v2.1.4
      - run: npm ci
      - run: npm test
  lint:
    runs-on: windows-2019
    steps:
      - uses: "actions/checkout@v3"
      - uses: actions/setup-node@v3
        with:
          node-version: '14'
      - run: npm run lint
`;

describe('GitHub Actions modernization', () => {
  it('fixes action versions, retired runners, and EOL Node versions with minimal line edits', () => {
    const r = analyzeWorkflow(OLD, 20);
    expect(r.findings.length).toBeGreaterThanOrEqual(8);
    expect(r.text).toContain('runs-on: ubuntu-latest  # old runner');
    expect(r.text).toContain('node-version: [20.x]');
    expect(r.text).toContain('os: [ubuntu-latest]');
    expect(r.text).toContain('- uses: actions/checkout@v4');
    expect(r.text).toContain('uses: actions/setup-node@v4');
    expect(r.text).toContain('- uses: actions/cache@v4');
    expect(r.text).toContain('- uses: "actions/checkout@v4"');
    expect(r.text).toContain("node-version: '20'");
    expect(r.text).toContain('runs-on: windows-latest');
    expect(r.text).toContain('# uses: actions/checkout@v1 (comment is untouched)');
    expect(r.text).toContain('node-version: ${{ matrix.node-version }}');
    expect(r.text.split('\n').length).toBe(OLD.split('\n').length);
    expect(isValidYaml(r.text)).toBe(true);
  });

  it('is idempotent: a fixed workflow has no findings', () => {
    const once = analyzeWorkflow(OLD, 20).text;
    const twice = analyzeWorkflow(once, 20);
    expect(twice.findings).toEqual([]);
    expect(twice.text).toBe(once);
  });

  it('keeps maintained Node versions and the verified runtime', () => {
    const wf = 'jobs:\n  t:\n    strategy:\n      matrix:\n        node: [ 14, 16, 18, 20 ]\n';
    expect(analyzeWorkflow(wf, 16).text).toContain('node: [16, 18, 20]');
  });

  it('rewrites block-style Node lists', () => {
    const wf =
      'jobs:\n  t:\n    strategy:\n      matrix:\n        node-version:\n          - 10\n          - 12\n          - 20\n    steps: []\n';
    const r = analyzeWorkflow(wf, 20);
    expect(r.text).toBe(
      'jobs:\n  t:\n    strategy:\n      matrix:\n        node-version:\n          - 20\n    steps: []\n',
    );
    expect(isValidYaml(r.text)).toBe(true);
  });

  it('preserves CRLF line endings', () => {
    const r = analyzeWorkflow('steps:\r\n  - uses: actions/checkout@v2\r\n', 20);
    expect(r.text).toBe('steps:\r\n  - uses: actions/checkout@v4\r\n');
  });
});
