'use strict';
import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gw = require('../gitWorktree.cjs');

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ign-'));
  dirs.push(root);
  const main = path.join(root, 'main');
  fs.mkdirSync(path.join(main, 'ops'), { recursive: true });
  git(['init', '-q', '-b', 'main'], main);
  git(['config', 'user.email', 't@e.com'], main);
  git(['config', 'user.name', 'T'], main);
  fs.writeFileSync(path.join(main, 'ops/state'), 'v1\n');
  git(['add', '-A'], main);
  git(['commit', '-qm', 'base'], main);
  git(['branch', 'epic'], main);
  return { root, main };
}
function branchCommit(root, main, extra) {
  const wt = path.join(root, 'wt');
  git(['worktree', 'add', '-q', wt, 'epic'], main);
  fs.mkdirSync(path.join(wt, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'ops/state'), 'STALE\n');
  git(['add', '-f', '-A'], wt);
  git(['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'stale'], wt);
}

test('diverged main: tracked-then-untracked ignored live file survives', async () => {
  const { root, main } = setup();
  fs.writeFileSync(path.join(main, '.gitignore'), 'ops/\n');
  git(['rm', '-q', '--cached', 'ops/state'], main);
  git(['add', '.gitignore'], main);
  git(['commit', '-qm', 'untrack'], main);
  fs.writeFileSync(path.join(main, 'ops/state'), 'LIVE\n');
  branchCommit(root, main);
  const r = await gw.integrateBranch({ cwd: main, branch: 'epic', key: 'k', kind: 'epic' });
  expect(r.ok).toBe(false);
  expect(r.reason).toContain('ops/state');
  expect(fs.readFileSync(path.join(main, 'ops/state'), 'utf8')).toBe('LIVE\n');
});

test('fast-forward: branch re-adding an ignored on-disk path is refused', async () => {
  const { root, main } = setup();
  fs.writeFileSync(path.join(main, '.gitignore'), 'ops/\n');
  git(['rm', '-q', '--cached', 'ops/state'], main);
  git(['add', '.gitignore'], main);
  git(['commit', '-qm', 'untrack'], main);
  git(['branch', '-f', 'epic', 'main'], main);
  fs.writeFileSync(path.join(main, 'ops/state'), 'LIVE\n');
  branchCommit(root, main);
  const r = await gw.integrateBranch({ cwd: main, branch: 'epic', key: 'k', kind: 'epic' });
  expect(r.ok).toBe(false);
  expect(fs.readFileSync(path.join(main, 'ops/state'), 'utf8')).toBe('LIVE\n');
});
