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
const { linkDependencyDirs, isPnpmProject } = require('../worktreeDeps.cjs');

const hasPnpm = (() => {
  try { execFileSync('pnpm', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const pnpmEnv = { ...process.env, CI: '1' };
const pnpm = (cwd, ...args) => execFileSync('pnpm', args, { cwd, env: pnpmEnv, stdio: 'pipe' });

/** Real pnpm workspace in `dir` with a workspace-local bin package; committed. */
function makePnpmFixture(dir) {
  fs.mkdirSync(path.join(dir, 'packages', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, dependencies: { lib: 'workspace:*' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  fs.writeFileSync(path.join(dir, 'packages', 'lib', 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0', bin: { libbin: 'bin.js' } }));
  fs.writeFileSync(path.join(dir, 'packages', 'lib', 'bin.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  pnpm(dir, 'install', '--offline');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'pnpm fixture');
}

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

test.skipIf(!hasPnpm)('pnpm worktree install never touches the main checkout node_modules', async () => {
  const pmain = path.join(root, 'pmain');
  const pwt = path.join(root, 'pwt');
  fs.mkdirSync(pmain);
  git(pmain, 'init', '-q', '-b', 'main');
  git(pmain, 'config', 'user.email', 't@t.t');
  git(pmain, 'config', 'user.name', 't');
  makePnpmFixture(pmain);
  git(pmain, 'worktree', 'add', '-q', '-b', 'pwt-branch', pwt, 'HEAD');
  fs.writeFileSync(path.join(pmain, 'node_modules', '.sentinel'), 'x');

  // pnpm 10 writes .modules.yaml only when registry packages are installed; a
  // workspace-local fixture (offline) may lack it, so assert it only if present.
  const modulesYaml = path.join(pmain, 'node_modules', '.modules.yaml');
  const hadModulesYaml = fs.existsSync(modulesYaml);

  const r = await linkDependencyDirs({ mainCwd: pmain, worktreeCwd: pwt });
  expect(r.linked).not.toContain('node_modules');
  expect(r.installed).toContain('node_modules');
  const st = fs.lstatSync(path.join(pwt, 'node_modules'));
  expect(st.isSymbolicLink()).toBe(false);
  expect(st.isDirectory()).toBe(true);

  pnpm(pwt, 'install', '--offline');
  expect(fs.existsSync(path.join(pmain, 'node_modules', '.sentinel'))).toBe(true);
  expect(fs.existsSync(modulesYaml)).toBe(hadModulesYaml);
  expect(fs.existsSync(path.join(pmain, 'node_modules', 'lib'))).toBe(true);
  expect(git(pwt, 'status', '--porcelain')).toBe('');
}, 60_000);

test.skipIf(!hasPnpm)('isPnpmProject is true for the pnpm fixture and false for the plain one', () => {
  const pmain = path.join(root, 'pmain2');
  fs.mkdirSync(pmain);
  git(pmain, 'init', '-q', '-b', 'main');
  git(pmain, 'config', 'user.email', 't@t.t');
  git(pmain, 'config', 'user.name', 't');
  makePnpmFixture(pmain);
  expect(isPnpmProject(pmain)).toBe(true);
  expect(isPnpmProject(main)).toBe(false);
  expect(isPnpmProject(path.join(root, 'nope'))).toBe(false);
}, 60_000);
