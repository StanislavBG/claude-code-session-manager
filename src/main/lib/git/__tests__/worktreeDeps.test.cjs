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
  // node_modules is a real folder of per-entry links; .venv stays a whole-folder link.
  expect(fs.lstatSync(path.join(wt, 'node_modules')).isDirectory()).toBe(true);
  expect(fs.readlinkSync(path.join(wt, '.venv'))).toBe(path.join(main, '.venv'));
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

test('runs the project worktreeSetup command in the worktree', async () => {
  fs.writeFileSync(path.join(wt, '.session-manager.json'), JSON.stringify({
    worktreeSetup: [`timeout 30 node -e 'require("fs").writeFileSync("setup-ran.txt","x")'`],
  }));
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.setup).toMatchObject({ ran: true, ok: true, reason: 'passed' });
  expect(fs.existsSync(path.join(wt, 'setup-ran.txt'))).toBe(true);
});

test('a failing worktreeSetup still resolves with setup.ok false', async () => {
  fs.writeFileSync(path.join(wt, '.session-manager.json'), JSON.stringify({
    worktreeSetup: ["timeout 30 node -e 'process.exit(3)'"],
  }));
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.setup).toMatchObject({ ran: true, ok: false, reason: 'failed' });
  expect(r.linked).toContain('node_modules');
});

/** Commit a package.json at each `dir` in main, refresh the worktree to it, create main's `<dir>/node_modules`. */
function addNestedPackages(dirs, { withMainModules = true } = {}) {
  for (const d of dirs) {
    fs.mkdirSync(path.join(main, d), { recursive: true });
    fs.writeFileSync(path.join(main, d, 'package.json'), JSON.stringify({ name: d.replace(/\W/g, '-') }));
    if (withMainModules) fs.mkdirSync(path.join(main, d, 'node_modules'), { recursive: true });
  }
  git(main, 'add', '.gitignore', ...dirs.map((d) => `${d}/package.json`));
  git(main, 'commit', '-q', '-m', 'nested');
  git(wt, 'reset', '-q', '--hard', 'main');
}

test('links a nested package node_modules and excludes it; status stays clean', async () => {
  addNestedPackages(['web/remote-app', 'a/b/c']);
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.linked).toEqual(['node_modules', '.venv', 'a/b/c/node_modules', 'web/remote-app/node_modules']);
  const dest = path.join(wt, 'web', 'remote-app', 'node_modules');
  expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
  expect(fs.lstatSync(dest).isDirectory()).toBe(true);
  const exclude = fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8').split('\n');
  expect(exclude).toContain('/web/remote-app/node_modules');
  expect(exclude).toContain('/a/b/c/node_modules');
  expect(git(wt, 'status', '--porcelain')).toBe('');
  expect(fs.lstatSync(path.join(main, 'web', 'remote-app', 'node_modules')).isSymbolicLink()).toBe(false);
});

test('skips nested packages deeper than 3 segments, under node_modules, or missing in main', async () => {
  fs.writeFileSync(path.join(main, '.gitignore'), '.venv/\n/node_modules/\nweb/node_modules/\n');
  addNestedPackages(['a/b/c/d']);
  addNestedPackages(['p'], { withMainModules: false });
  // A tracked package.json under a node_modules segment (force-added).
  fs.mkdirSync(path.join(main, 'vendor', 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(main, 'vendor', 'node_modules', 'x', 'package.json'), '{}');
  git(main, 'add', '-f', 'vendor/node_modules/x/package.json');
  git(main, 'commit', '-q', '-m', 'vendored');
  git(wt, 'reset', '-q', '--hard', 'main');
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.linked).toEqual(['node_modules', '.venv']);
  // Ineligible packages are not failures: nothing nested lands in skipped.
  expect(r.skipped.some((s) => s.includes('/') || s.startsWith('p/'))).toBe(false);
});

test('skips a nested node_modules that is not gitignored', async () => {
  fs.writeFileSync(path.join(main, '.gitignore'), '/node_modules/\n.venv/\n');
  addNestedPackages(['web/remote-app']);
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.skipped.some((s) => s.startsWith('web/'))).toBe(false);
  expect(r.linked).not.toContain('web/remote-app/node_modules');
  expect(fs.existsSync(path.join(wt, 'web', 'remote-app', 'node_modules'))).toBe(false);
});

test('leaves an existing worktree nested node_modules alone', async () => {
  addNestedPackages(['web/remote-app']);
  fs.mkdirSync(path.join(wt, 'web', 'remote-app', 'node_modules'));
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.skipped.some((s) => s.startsWith('web/'))).toBe(false);
  expect(fs.lstatSync(path.join(wt, 'web', 'remote-app', 'node_modules')).isSymbolicLink()).toBe(false);
});

test('pnpm projects skip nested linking', async () => {
  addNestedPackages(['web/remote-app']);
  fs.writeFileSync(path.join(main, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.linked).not.toContain('web/remote-app/node_modules');
  expect(r.skipped).not.toContain('web/remote-app/node_modules');
  expect(fs.existsSync(path.join(wt, 'web', 'remote-app', 'node_modules'))).toBe(false);
}, 60_000);

test('links at most 20 nested packages', async () => {
  const dirs = Array.from({ length: 23 }, (_, i) => `pkgs/p${String(i).padStart(2, '0')}`);
  addNestedPackages(dirs);
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  const nested = r.linked.filter((n) => n.startsWith('pkgs/'));
  expect(nested).toHaveLength(20);
  expect(nested).toEqual(dirs.slice(0, 20).map((d) => `${d}/node_modules`));
  for (const d of dirs.slice(20)) {
    expect(r.skipped).toContainEqual(expect.stringMatching(new RegExp(`^${d}/node_modules \\(.+\\)$`)));
  }
  expect(fs.existsSync(path.join(wt, 'pkgs', 'p22', 'node_modules'))).toBe(false);
  expect(git(wt, 'status', '--porcelain')).toBe('');
});

test('filters before capping: the last-sorting of 25 packages is linked when it alone is eligible', async () => {
  const dirs = Array.from({ length: 25 }, (_, i) => `pkgs/p${String(i).padStart(2, '0')}`);
  addNestedPackages(dirs, { withMainModules: false });
  const last = dirs[dirs.length - 1];
  fs.mkdirSync(path.join(main, last, 'node_modules'), { recursive: true });
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.linked.filter((n) => n.startsWith('pkgs/'))).toEqual([`${last}/node_modules`]);
  expect(r.skipped.filter((n) => n.startsWith('pkgs/'))).toEqual([]);
  expect(fs.lstatSync(path.join(wt, last, 'node_modules')).isDirectory()).toBe(true);
  expect(git(wt, 'status', '--porcelain')).toBe('');
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
test.skipIf(isRoot)('a failed nested symlink is skipped with a reason and leaves no exclude line', async () => {
  addNestedPackages(['web/remote-app']);
  const parent = path.join(wt, 'web', 'remote-app');
  fs.chmodSync(parent, 0o555);
  let r;
  try {
    r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  } finally {
    fs.chmodSync(parent, 0o755);
  }
  expect(r.linked).not.toContain('web/remote-app/node_modules');
  expect(r.skipped).toContainEqual(expect.stringMatching(/^web\/remote-app\/node_modules \(.+\)$/));
  expect(fs.existsSync(path.join(parent, 'node_modules'))).toBe(false);
  const exclude = fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8').split('\n');
  expect(exclude).not.toContain('/web/remote-app/node_modules');
});

/**
 * Fake installed node_modules at `dir`: a package with a bin, a scope folder, .bin, and dot
 * entries that must not be linked.
 */
function fakeNodeModules(dir) {
  fs.mkdirSync(path.join(dir, 'dummy-pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dummy-pkg', 'package.json'), JSON.stringify({ name: 'dummy-pkg', version: '1.0.0', main: 'index.js', bin: { dummy: 'cli.js' } }));
  fs.writeFileSync(path.join(dir, 'dummy-pkg', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, 'dummy-pkg', 'cli.js'), '#!/usr/bin/env node\n');
  fs.mkdirSync(path.join(dir, '@types', 'dummy'), { recursive: true });
  fs.writeFileSync(path.join(dir, '@types', 'dummy', 'package.json'), JSON.stringify({ name: '@types/dummy', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, '@types', 'dummy', 'index.d.ts'), 'export {};\n');
  fs.mkdirSync(path.join(dir, '.bin'), { recursive: true });
  fs.symlinkSync('../dummy-pkg/cli.js', path.join(dir, '.bin', 'dummy'));
  fs.mkdirSync(path.join(dir, '.vite'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.package-lock.json'), '{}');
}

/** Every file/dir path under `dir` (lstat, links not followed), relative. */
function tree(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    out.push(r);
    if (e.isDirectory()) out.push(...tree(dir, r));
  }
  return out.sort();
}

test('node_modules is a real worktree folder of per-entry links (root and nested)', async () => {
  addNestedPackages(['web/feedback-widget']);
  for (const rel of ['node_modules', 'web/feedback-widget/node_modules']) fakeNodeModules(path.join(main, rel));
  const r = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r.linked).toEqual(['node_modules', '.venv', 'web/feedback-widget/node_modules']);
  for (const rel of ['node_modules', 'web/feedback-widget/node_modules']) {
    const dest = path.join(wt, rel);
    const st = fs.lstatSync(dest);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    expect(fs.readdirSync(dest).sort()).toEqual(['.bin', '@types', 'dummy-pkg']);
    for (const e of ['.bin', '@types', 'dummy-pkg']) {
      expect(fs.lstatSync(path.join(dest, e)).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(dest, e))).toBe(path.join(main, rel, e));
    }
  }
  expect(git(wt, 'status', '--porcelain')).toBe('');
});

test('require.resolve and .bin scripts resolve from the worktree to the main checkout files', async () => {
  addNestedPackages(['web/feedback-widget']);
  for (const rel of ['node_modules', 'web/feedback-widget/node_modules']) fakeNodeModules(path.join(main, rel));
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  for (const dir of ['', 'web/feedback-widget']) {
    const fromWt = path.join(wt, dir);
    const mainNm = path.join(main, dir, 'node_modules');
    const resolved = execFileSync(process.execPath, ['-e', "process.stdout.write(require.resolve('dummy-pkg'))"], { cwd: fromWt, encoding: 'utf8' });
    expect(resolved).toBe(path.join(mainNm, 'dummy-pkg', 'index.js'));
    const typesPkg = execFileSync(process.execPath, ['-e', "process.stdout.write(require.resolve('@types/dummy/package.json'))"], { cwd: fromWt, encoding: 'utf8' });
    expect(typesPkg).toBe(path.join(mainNm, '@types', 'dummy', 'package.json'));
    expect(fs.realpathSync(path.join(fromWt, 'node_modules', '.bin', 'dummy'))).toBe(path.join(mainNm, 'dummy-pkg', 'cli.js'));
  }
});

// 2026-11-24: a widget gate's `npm --prefix web/feedback-widget ci` in a job worktree emptied the
// main checkout's web/feedback-widget/node_modules through a whole-folder symlink.
test('npm ci in a worktree package removes only links, never the main checkout entries', async () => {
  addNestedPackages(['web/feedback-widget']);
  for (const rel of ['node_modules', 'web/feedback-widget/node_modules']) fakeNodeModules(path.join(main, rel));
  const before = {
    root: tree(path.join(main, 'node_modules')),
    nested: tree(path.join(main, 'web', 'feedback-widget', 'node_modules')),
  };
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  const pkgDir = path.join(wt, 'web', 'feedback-widget');
  const name = 'web-feedback-widget';
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  fs.writeFileSync(path.join(pkgDir, 'package-lock.json'), JSON.stringify({
    name, version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name, version: '1.0.0' } },
  }));
  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--offline'], { cwd: pkgDir, stdio: 'pipe', timeout: 60_000 });
  expect(tree(path.join(main, 'node_modules'))).toEqual(before.root);
  expect(tree(path.join(main, 'web', 'feedback-widget', 'node_modules'))).toEqual(before.nested);
  expect(before.nested).toEqual(expect.arrayContaining(['dummy-pkg', '@types', '.bin', path.join('@types', 'dummy', 'index.d.ts')]));
}, 60_000);

// ── syncNodeModulesLinks: refresh a live worktree's per-entry links ──

test('sync links a main entry added after the initial link, skipping dot caches', async () => {
  const { syncNodeModulesLinks } = require('../worktreeDeps.cjs');
  fs.mkdirSync(path.join(main, 'node_modules', 'old'));
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  fs.mkdirSync(path.join(main, 'node_modules', 'newpkg'));
  fs.mkdirSync(path.join(main, 'node_modules', '.vite'));
  fs.mkdirSync(path.join(main, 'node_modules', '.bin'));
  const r = await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt });
  expect(r).toEqual({ added: 2, removed: 0, kept: 0 });
  expect(fs.readlinkSync(path.join(wt, 'node_modules', 'newpkg'))).toBe(path.join(main, 'node_modules', 'newpkg'));
  expect(fs.readlinkSync(path.join(wt, 'node_modules', '.bin'))).toBe(path.join(main, 'node_modules', '.bin'));
  expect(fs.existsSync(path.join(wt, 'node_modules', '.vite'))).toBe(false);
  expect(git(wt, 'status', '--porcelain')).toBe('');
  expect(await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt })).toEqual({ added: 0, removed: 0, kept: 0 });
});

test('sync removes a dangling link and keeps a worktree-local real package', async () => {
  const { syncNodeModulesLinks } = require('../worktreeDeps.cjs');
  fs.mkdirSync(path.join(main, 'node_modules', 'gone'));
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  fs.rmSync(path.join(main, 'node_modules', 'gone'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'node_modules', 'local'));
  fs.writeFileSync(path.join(wt, 'node_modules', 'local', 'index.js'), 'x');
  fs.mkdirSync(path.join(main, 'node_modules', 'local')); // same name in main: real worktree entry wins
  const r = await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt });
  expect(r).toEqual({ added: 0, removed: 1, kept: 0 });
  expect(exists(path.join(wt, 'node_modules', 'gone'))).toBe(false);
  expect(fs.lstatSync(path.join(wt, 'node_modules', 'local')).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(path.join(wt, 'node_modules', 'local', 'index.js'), 'utf8')).toBe('x');
  expect(fs.existsSync(path.join(main, 'node_modules', 'local'))).toBe(true);
});

test('sync removes only linker-made dangling links; a dangling link elsewhere is kept', async () => {
  const { syncNodeModulesLinks } = require('../worktreeDeps.cjs');
  fs.mkdirSync(path.join(main, 'node_modules', 'gone'));
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  fs.rmSync(path.join(main, 'node_modules', 'gone'), { recursive: true });
  // workspace package mid-build: a worktree-made link whose target is briefly missing
  fs.symlinkSync(path.join(wt, 'packages', 'ws'), path.join(wt, 'node_modules', 'ws'), 'dir');
  // sibling-prefix target (main/node_modules-x) is NOT inside main/node_modules
  fs.symlinkSync(`${path.join(main, 'node_modules')}-x`, path.join(wt, 'node_modules', 'prefix'), 'dir');
  const r = await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt });
  expect(r).toEqual({ added: 0, removed: 1, kept: 2 });
  expect(exists(path.join(wt, 'node_modules', 'gone'))).toBe(false);
  expect(fs.readlinkSync(path.join(wt, 'node_modules', 'ws'))).toBe(path.join(wt, 'packages', 'ws'));
  expect(fs.lstatSync(path.join(wt, 'node_modules', 'prefix')).isSymbolicLink()).toBe(true);
});

test('sync keeps a dangling link pointing inside the worktree (kept: 1)', async () => {
  const { syncNodeModulesLinks } = require('../worktreeDeps.cjs');
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  fs.symlinkSync('../packages/ws', path.join(wt, 'node_modules', 'ws'), 'dir'); // relative target
  const r = await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt });
  expect(r).toEqual({ added: 0, removed: 0, kept: 1 });
  expect(fs.readlinkSync(path.join(wt, 'node_modules', 'ws'))).toBe('../packages/ws');
});

test('sync refreshes a nested package node_modules too', async () => {
  const { syncNodeModulesLinks } = require('../worktreeDeps.cjs');
  fs.mkdirSync(path.join(main, 'web', 'app'), { recursive: true });
  fs.writeFileSync(path.join(main, 'web', 'app', 'package.json'), '{}');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'nested');
  git(wt, 'merge', '-q', 'main');
  fs.mkdirSync(path.join(main, 'web', 'app', 'node_modules', 'a'), { recursive: true });
  const r0 = await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  expect(r0.linked).toContain('web/app/node_modules');
  fs.mkdirSync(path.join(main, 'web', 'app', 'node_modules', 'b'));
  const r = await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt });
  expect(r).toEqual({ added: 1, removed: 0, kept: 0 });
  expect(fs.readlinkSync(path.join(wt, 'web', 'app', 'node_modules', 'b'))).toBe(path.join(main, 'web', 'app', 'node_modules', 'b'));
});

test('sync leaves a whole-folder node_modules symlink alone', async () => {
  const { syncNodeModulesLinks } = require('../worktreeDeps.cjs');
  fs.symlinkSync(path.join(main, 'node_modules'), path.join(wt, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(main, 'node_modules', 'pkg'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(main, 'node_modules', 'dangling-in-main'));
  const r = await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt });
  expect(r).toEqual({ added: 0, removed: 0, kept: 0 });
  expect(fs.readlinkSync(path.join(wt, 'node_modules'))).toBe(path.join(main, 'node_modules'));
  expect(fs.readdirSync(path.join(main, 'node_modules')).sort()).toEqual(['dangling-in-main', 'pkg']);
  expect(fs.lstatSync(path.join(main, 'node_modules', 'pkg')).isDirectory()).toBe(true);
});

test('sync is a no-op under SM_WORKTREE_DEP_LINK_DISABLE=1 and never throws on a bogus cwd', async () => {
  const { syncNodeModulesLinks } = require('../worktreeDeps.cjs');
  await linkDependencyDirs({ mainCwd: main, worktreeCwd: wt });
  fs.mkdirSync(path.join(main, 'node_modules', 'later'));
  const prev = process.env.SM_WORKTREE_DEP_LINK_DISABLE;
  process.env.SM_WORKTREE_DEP_LINK_DISABLE = '1';
  try {
    expect(await syncNodeModulesLinks({ mainCwd: main, worktreeCwd: wt })).toEqual({ added: 0, removed: 0, kept: 0 });
    expect(exists(path.join(wt, 'node_modules', 'later'))).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.SM_WORKTREE_DEP_LINK_DISABLE; else process.env.SM_WORKTREE_DEP_LINK_DISABLE = prev;
  }
  expect(await syncNodeModulesLinks({ mainCwd: path.join(root, 'nope'), worktreeCwd: path.join(root, 'nope2') })).toEqual({ added: 0, removed: 0, kept: 0 });
});

function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
