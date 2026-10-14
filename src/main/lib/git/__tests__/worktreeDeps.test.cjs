/**
 * worktreeDeps.test.cjs — linkDependencyDirs against a real temp repo + worktree.
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/worktreeDeps.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { linkDependencyDirs } = require('../worktreeDeps.cjs');

let root, main, wt;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtdeps-')));
  main = path.join(root, 'main');
  wt = path.join(root, 'wt');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 't@t.t');
  git(main, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules/\n.venv/\n');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'wt-branch', wt, 'HEAD');
  for (const d of ['node_modules', '.venv', 'venv']) fs.mkdirSync(path.join(main, d));
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('links ignored dir, skips non-ignored, status stays clean', async () => {
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.linked).toEqual(['node_modules', '.venv']);
  expect(r.skipped).toEqual(['venv']); // exists but not ignored
  expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(path.join(wt, 'node_modules'))).toBe(path.join(main, 'node_modules'));
  expect(fs.existsSync(path.join(wt, 'venv'))).toBe(false);
  expect(git(wt, 'status', '--porcelain')).toBe('');
});

test('leaves an existing target alone', async () => {
  fs.mkdirSync(path.join(wt, 'node_modules'));
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.skipped).toContain('node_modules');
  expect(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
});

test('does not duplicate exclude lines on a second call', async () => {
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  const exclude = fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8').split('\n');
  expect(exclude.filter((l) => l === '/node_modules')).toHaveLength(1);
  expect(exclude.filter((l) => l === '/.venv')).toHaveLength(1);
});

test('never throws on a bogus cwd', async () => {
  const r = await linkDependencyDirs({ mainCwd: path.join(root, 'nope'), worktreeCwd: wt });
  expect(r.linked).toEqual([]);
});
