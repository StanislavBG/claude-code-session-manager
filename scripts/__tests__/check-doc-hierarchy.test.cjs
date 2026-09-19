/**
 * check-doc-hierarchy.test.cjs — the doc-hierarchy linter fails on each defect
 * class and passes on a clean scratch tree.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/check-doc-hierarchy.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../check-doc-hierarchy.cjs');
const OPS = 'session-manager-operations';
const FILES = [
  'README.md', 'src/CLAUDE.md', 'src/renderer/CLAUDE.md', 'scripts/README.md', 'tests/README.md',
  'web/README.md', 'web/remote-app/CLAUDE.md', 'web-remote/CLAUDE.md', 'plugins/CLAUDE.md',
  `${OPS}/CLAUDE.md`, `${OPS}/architecture/README.md`, `${OPS}/scheduler/README.md`,
];

let root;
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = () => spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-hier-'));
  for (const f of FILES) write(f, '# doc\n');
  write('CLAUDE.md', '> **SIZE BUDGET — 12,000 chars**\n\n## Scoped MDs\n\n| Path | Scope |\n| --- | --- |\n| [`src/CLAUDE.md`](src/CLAUDE.md) | main |\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('clean scratch tree passes', () => {
  const r = run();
  expect(r.status, r.stderr).toBe(0);
});

test('missing junction file fails', () => {
  fs.rmSync(path.join(root, 'tests/README.md'));
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('missing junction: tests/README.md');
});

test('oversized nested CLAUDE.md fails', () => {
  write('src/CLAUDE.md', 'x'.repeat(4001));
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('src/CLAUDE.md is 4001 bytes');
});

test('broken relative link fails', () => {
  write('web/README.md', 'see [gone](./nope.md#top)\n');
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('web/README.md: broken relative link: ./nope.md#top');
});

test('file:// link fails', () => {
  write('plugins/CLAUDE.md', '[abs](file:///home/x/y.md)\n');
  const r = run();
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('plugins/CLAUDE.md: file:// link');
});
