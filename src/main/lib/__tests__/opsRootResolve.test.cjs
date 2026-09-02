'use strict';
// Run: timeout 120 npx vitest run src/main/lib/__tests__/opsRootResolve.test.cjs
//
// PRD 1082 — opsOwnership.cjs is THE ONE ops-root resolver. Every reader and
// writer of `<project>/session-manager-operations/` builds its path through
// resolveProjectRoot / resolveOpsRoot / opsPath, which normalize a worktree or
// ops-internal cwd to the real project and refuse an ephemeral one. Before
// this, each namespace did its own `path.join(cwd, 'session-manager-
// operations', ...)`, so the worktree-cwd hazard had to be fixed one call site
// at a time (2026-08-30, PRDs 1073/1074/1081).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  resolveProjectRoot, resolveOpsRoot, opsPath, assertOpsWrite, OPS_ROOT_DIR,
} = require('../opsOwnership.cjs');
const { KIND_CONFIG } = require('../gitWorktree.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

/** A fake main tree (has a real `.git` DIRECTORY) outside os.tmpdir(). */
async function mkMainTree() {
  const base = path.join(os.homedir(), '.cache', 'sm-opsroot-resolve-tests');
  fs.mkdirSync(base, { recursive: true });
  const main = await fsp.mkdtemp(path.join(base, 'main-'));
  tmpDirs.push(main);
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  return main;
}

/** A linked worktree of `main` (a `.git` FILE + the admin back-reference git writes). */
async function mkLinkedWorktree(main) {
  const worktree = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-resolve-wt-'));
  tmpDirs.push(worktree);
  const name = 'sm-epic-test';
  const adminDir = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(adminDir, { recursive: true });
  const gitFile = path.join(worktree, '.git');
  fs.writeFileSync(path.join(adminDir, 'gitdir'), `${gitFile}\n`);
  fs.writeFileSync(gitFile, `gitdir: ${adminDir}\n`);
  return worktree;
}

// ─── byte-equality regression for the common case ──────────────────────────

test('a plain project root resolves to <root>/session-manager-operations, byte-identical to the old join', async () => {
  const main = await mkMainTree();
  assert.equal(resolveProjectRoot(main), main);
  assert.equal(resolveOpsRoot(main), path.join(main, OPS_ROOT_DIR));
  assert.equal(
    opsPath(main, 'prompt-sessions', 'active-index.json'),
    path.join(main, 'session-manager-operations', 'prompt-sessions', 'active-index.json'),
  );
});

test('a plain directory with no enclosing .git anywhere is returned unchanged', () => {
  const p = '/definitely/not/a/real/project';
  assert.equal(resolveProjectRoot(p), p);
  assert.equal(opsPath(p, 'logs'), path.join(p, OPS_ROOT_DIR, 'logs'));
});

// ─── normalization ──────────────────────────────────────────────────────────

test('a linked worktree root resolves to its MAIN tree', async () => {
  const main = await mkMainTree();
  const wt = await mkLinkedWorktree(main);
  assert.equal(resolveProjectRoot(wt), main);
  assert.equal(opsPath(wt, 'scheduler', 'state'), path.join(main, OPS_ROOT_DIR, 'scheduler', 'state'));
});

test("a cwd deep inside a worktree's OWN ops tree resolves to the main tree's ops root", async () => {
  const main = await mkMainTree();
  const wt = await mkLinkedWorktree(main);
  const nested = path.join(wt, OPS_ROOT_DIR, 'scheduler', 'state');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveOpsRoot(nested), path.join(main, OPS_ROOT_DIR));
});

test('an ops-internal cwd of a plain project is truncated to the project (default normalize)', async () => {
  const main = await mkMainTree();
  const inside = path.join(main, OPS_ROOT_DIR, 'scheduler', 'epics', 'e1', 'prds');
  assert.equal(resolveProjectRoot(inside), main);
});

test("a subdirectory of a git repo resolves to the repo root (the 2026-08-13 'src/main' stray-root shape)", async () => {
  const main = await mkMainTree();
  const sub = path.join(main, 'src', 'main', 'lib');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolveProjectRoot(sub), main);
});

test('a nested project that is its OWN git repo keeps its own root', async () => {
  const outer = await mkMainTree();
  const inner = path.join(outer, 'apps', 'inner');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  assert.equal(resolveProjectRoot(inner), inner);
});

// ─── refusals ───────────────────────────────────────────────────────────────

test("opsInternal:'refuse' throws on an ops-internal cwd instead of normalizing (the writer posture)", async () => {
  const main = await mkMainTree();
  const inside = path.join(main, OPS_ROOT_DIR, 'scheduler', 'state');
  assert.throws(() => resolveProjectRoot(inside, { opsInternal: 'refuse' }), /not a path inside session-manager-operations/);
});

test('os.tmpdir() itself is refused with a tagged ephemeral error', () => {
  assert.throws(() => resolveOpsRoot(os.tmpdir()), (e) => e.ephemeral === true && /ephemeral/.test(e.message));
});

test('a bare, .git-less dir under a managed worktree root is refused (cannot be normalized)', async () => {
  fs.mkdirSync(KIND_CONFIG.epic.root, { recursive: true });
  const bare = await fsp.mkdtemp(path.join(KIND_CONFIG.epic.root, 'sm-opsroot-resolve-bare-'));
  tmpDirs.push(bare);
  assert.throws(() => opsPath(bare, 'logs'), (e) => e.ephemeral === true);
});

test('relative, empty and non-string cwds throw (never resolved against process.cwd())', () => {
  assert.throws(() => resolveProjectRoot('src/main/lib'), /absolute/);
  assert.throws(() => resolveProjectRoot(''), /required/);
  assert.throws(() => resolveProjectRoot(null), /required/);
  assert.throws(() => resolveProjectRoot(42), /required/);
});

// ─── the single-writer gate is also the last line ──────────────────────────

test('assertOpsWrite refuses a well-owned write whose project root is a linked worktree', async () => {
  const main = await mkMainTree();
  const wt = await mkLinkedWorktree(main);
  const target = path.join(wt, OPS_ROOT_DIR, 'scheduler', 'state', 'queue.json');
  assert.throws(() => assertOpsWrite(target, 'scheduler'), (e) => e.ephemeral === true);
  // ...while the same write against the main tree is fine.
  assert.doesNotThrow(() => assertOpsWrite(path.join(main, OPS_ROOT_DIR, 'scheduler', 'state', 'queue.json'), 'scheduler'));
});

test('assertOpsWrite still refuses the wrong writer before it ever looks at the root', async () => {
  const main = await mkMainTree();
  assert.throws(
    () => assertOpsWrite(path.join(main, OPS_ROOT_DIR, 'scheduler', 'state', 'queue.json'), 'epics'),
    /single-writer law/,
  );
});
