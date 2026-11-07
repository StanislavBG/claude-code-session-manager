/**
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/carryExcludesRuntimeState.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { captureAndCarryBaseDiff } = require('../gitWorktree.cjs');

let root;
let wt;
const HIST = 'session-manager-operations/scheduler/state/history.jsonl';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const write = (rel, c) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), c);
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cers-')));
  wt = `${root}-wt`;
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 't@example.com');
  g(root, 'config', 'user.name', 't');
  g(root, 'config', 'commit.gpgsign', 'false');
  write('src/a.txt', 'one\n');
  write(HIST, 'old\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-qm', 'init');
  g(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  write('src/a.txt', 'two\n');
  write(HIST, 'dirty\n');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(wt, { recursive: true, force: true });
});

test('carry skips runtime ops state but carries normal WIP', async () => {
  const r = await captureAndCarryBaseDiff({ cwd: root, dir: wt });
  expect(r.ok).toBe(true);
  expect(r.paths).toEqual(['src/a.txt']);
  expect(fs.readFileSync(path.join(wt, 'src/a.txt'), 'utf8')).toBe('two\n');
  expect(fs.readFileSync(path.join(wt, HIST), 'utf8')).toBe('old\n');
  expect(g(wt, 'status', '--porcelain', '--', 'session-manager-operations/scheduler/').trim()).toBe('');
});
