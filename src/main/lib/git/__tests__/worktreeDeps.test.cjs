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
const { linkDependencyDirs, isPnpmProject, isUvProject } = require('../worktreeDeps.cjs');

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

const hasUv = (() => {
  try { execFileSync('uv', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
const uvEnv = (() => { const e = { ...process.env }; delete e.VIRTUAL_ENV; delete e.UV_PROJECT_ENVIRONMENT; return e; })();
const uv = (cwd, ...args) => execFileSync('uv', args, { cwd, env: uvEnv, stdio: 'pipe' });

/** uv project in `dir` with an editable package `pkgx`, synced offline; committed. */
function makeUvFixture(dir) {
  fs.mkdirSync(path.join(dir, 'src', 'pkgx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pkgx', '__init__.py'), 'WHERE = __file__\n');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), [
    '[project]', 'name = "pkgx"', 'version = "0.1.0"', 'requires-python = ">=3.8"', 'dependencies = []',
    '[build-system]', 'requires = ["uv_build"]', 'build-backend = "uv_build"', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.venv/\n__pycache__/\n');
  uv(dir, 'lock', '--offline');
  uv(dir, 'sync', '--frozen', '--offline');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'uv fixture');
}

const whereFrom = (venvPython, cwd) =>
  execFileSync(venvPython, ['-c', 'import pkgx; print(pkgx.WHERE)'], { cwd, encoding: 'utf8' }).trim();

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

/** Symlinks under `dir` (not followed) whose target does not exist. */
function danglingLinks(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { if (!fs.existsSync(p)) out.push(p); } else if (e.isDirectory()) out.push(...danglingLinks(p));
  }
  return out;
}

// Bilko-Launch-Kit incident (2026-10-18): a job ran pnpm through a symlinked node_modules, the main
// checkout's links were repointed into the job worktree and dangled once the worktree was deleted.
test.skipIf(!hasPnpm)('pnpm update in a worktree leaves no dangling links in the main node_modules', async () => {
  const pmain = path.join(root, 'pmain3');
  const pwt = path.join(root, 'pwt3');
  fs.mkdirSync(pmain);
  git(pmain, 'init', '-q', '-b', 'main');
  git(pmain, 'config', 'user.email', 't@t.t');
  git(pmain, 'config', 'user.name', 't');
  makePnpmFixture(pmain);
  git(pmain, 'worktree', 'add', '-q', '-b', 'pwt3-branch', pwt, 'HEAD');

  await linkDependencyDirs({ mainCwd: pmain, worktreeCwd: pwt });
  pnpm(pwt, 'update', '--offline', 'lib');
  git(pmain, 'worktree', 'remove', '--force', pwt);

  expect(danglingLinks(path.join(pmain, 'node_modules'))).toEqual([]);
  expect(fs.existsSync(path.join(pmain, 'node_modules', 'lib', 'package.json'))).toBe(true);
}, 60_000);

// Bilko-Launch-Kit: `file:../Bilko/packages/host-kit` cannot resolve from a worktree that is not
// next to the sibling repo, so the offline install ENOENTs and the worktree gets no node_modules.
test.skipIf(!hasPnpm)('pnpm worktree resolves out-of-repo file: deps through a link and never touches main', async (ctx) => {
  const pmain = path.join(root, 'repos', 'pmain');
  const sibling = path.join(root, 'repos', 'sibling', 'pkg');
  const pwt = path.join(root, 'wts', 'h', 'pwt');
  fs.mkdirSync(pmain, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(path.dirname(pwt), { recursive: true });
  fs.writeFileSync(path.join(sibling, 'package.json'), JSON.stringify({ name: 'sib', version: '1.0.0' }));
  git(pmain, 'init', '-q', '-b', 'main');
  git(pmain, 'config', 'user.email', 't@t.t');
  git(pmain, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(pmain, 'package.json'), JSON.stringify({ name: 'root', private: true, dependencies: { sib: 'file:../sibling/pkg' } }));
  fs.writeFileSync(path.join(pmain, '.gitignore'), 'node_modules/\n');
  try { pnpm(pmain, 'install', '--offline'); } catch { ctx.skip(); }
  git(pmain, 'add', '.');
  git(pmain, 'commit', '-q', '-m', 'file dep fixture');
  git(pmain, 'worktree', 'add', '-q', '-b', 'pwt4-branch', pwt, 'HEAD');
  fs.writeFileSync(path.join(pmain, 'node_modules', '.sentinel'), 'x');

  const r = await linkDependencyDirs({ mainCwd: pmain, worktreeCwd: pwt });
  expect(r.installed).toContain('node_modules');
  const st = fs.lstatSync(path.join(pwt, 'node_modules'));
  expect(st.isSymbolicLink()).toBe(false);
  expect(st.isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(pmain, 'node_modules', '.sentinel'))).toBe(true);
  expect(fs.readdirSync(pmain).sort()).toEqual(['.git', '.gitignore', 'node_modules', 'package.json', 'pnpm-lock.yaml']);
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

test.skipIf(!hasUv)('uv worktree gets its own .venv; uv sync/run there never repoints the main checkout', async (ctx) => {
  const umain = path.join(root, 'umain');
  const uwt = path.join(root, 'uwt');
  fs.mkdirSync(umain);
  git(umain, 'init', '-q', '-b', 'main');
  git(umain, 'config', 'user.email', 't@t.t');
  git(umain, 'config', 'user.name', 't');
  try { makeUvFixture(umain); } catch { ctx.skip(); } // no cached python/uv_build offline
  git(umain, 'worktree', 'add', '-q', '-b', 'uwt-branch', uwt, 'HEAD');
  const mainPy = path.join(umain, '.venv', 'bin', 'python');
  const mainSrc = path.join(umain, 'src', 'pkgx', '__init__.py');
  expect(isUvProject(umain)).toBe(true);
  expect(whereFrom(mainPy, root)).toBe(mainSrc);

  const r = await linkDependencyDirs({ mainCwd: umain, worktreeCwd: uwt });
  expect(r.linked).not.toContain('.venv');
  expect(r.installed).toContain('.venv');
  const st = fs.lstatSync(path.join(uwt, '.venv'));
  expect(st.isSymbolicLink()).toBe(false);
  expect(st.isDirectory()).toBe(true);

  // The executor's own uv calls inside the worktree.
  uv(uwt, 'sync', '--offline');
  uv(uwt, 'run', '--offline', 'python', '-c', 'pass');
  expect(whereFrom(mainPy, root)).toBe(mainSrc);
  expect(whereFrom(path.join(uwt, '.venv', 'bin', 'python'), root)).toBe(path.join(uwt, 'src', 'pkgx', '__init__.py'));
  expect(git(uwt, 'status', '--porcelain')).toBe('');
}, 60_000);

test('isUvProject is false without uv.lock', () => {
  expect(isUvProject(main)).toBe(false);
  expect(isUvProject(path.join(root, 'nope'))).toBe(false);
});
