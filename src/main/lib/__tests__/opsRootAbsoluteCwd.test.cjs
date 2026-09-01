/**
 * opsRootAbsoluteCwd.test.cjs — a project cwd must be an ABSOLUTE path, at
 * both ends of the ops-root resolution chain.
 *
 * The incident this guards (observed live 2026-08-13): five stray
 * `session-manager-operations/scheduler/state/queue.json` trees appeared under
 * source directories — `src/main/lib/`, `src/main/`, `src/renderer/state/`,
 * `src/renderer/components/epics/`, `src/renderer/testUtils/` — each holding
 * an empty `{"jobs": []}`. Cause: `path.join()` silently resolves a RELATIVE
 * first segment against `process.cwd()`, so a caller handing
 * `projectStateDir()` a repo-relative fragment like `src/main/lib` gets a
 * plausible-looking absolute path pointing at entirely the wrong place, and a
 * whole ops root is materialized there. Nothing threw; the writes "succeeded".
 *
 * This is the ops-root hazard gitWorktree.cjs's header comment describes,
 * reached from the opposite end: not a worktree dir substituted for a project
 * cwd, but a relative fragment accepted as one. A PROJECT IS A CWD and a cwd
 * is absolute (CLAUDE.md's knownProjectAggregate.ts bullet says the same
 * thing renderer-side) — so both layers fail closed rather than guessing.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/opsRootAbsoluteCwd.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const queueStore = require('../queueStore.cjs');
const { activeProjectCwds } = require('../../../../scripts/lib/activeSessions.cjs');

const tmpDirs = [];

afterEach(async () => {
  while (tmpDirs.length) {
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

// ─── queueStore.projectStateDir — the write-path guard ──────────────────────

test('projectStateDir refuses a relative cwd instead of resolving it against process.cwd()', () => {
  expect(() => queueStore.projectStateDir('src/main/lib')).toThrow(/absolute path/);
  expect(() => queueStore.projectStateDir('./somewhere')).toThrow(/absolute path/);
  expect(() => queueStore.projectStateDir('..')).toThrow(/absolute path/);
});

test('projectStateDir names the offending value so a bad caller is findable from the log alone', () => {
  expect(() => queueStore.projectStateDir('src/renderer/state')).toThrow(/src\/renderer\/state/);
});

test('projectStateDir still accepts an absolute cwd and appends the ops-root subpath', () => {
  const dir = queueStore.projectStateDir('/projects/foo');
  expect(dir).toBe(path.join('/projects/foo', 'session-manager-operations', 'scheduler', 'state'));
});

test('projectStateDir keeps rejecting a missing/non-string cwd', () => {
  expect(() => queueStore.projectStateDir()).toThrow(/cwd is required/);
  expect(() => queueStore.projectStateDir('')).toThrow(/cwd is required/);
  expect(() => queueStore.projectStateDir(42)).toThrow(/cwd is required/);
});

// ─── activeSessions.addCwd — the upstream guard ─────────────────────────────
//
// Building a transcript fixture whose recorded `cwd` is relative is the whole
// point: statSync('src/main/lib') SUCCEEDS whenever this process happens to
// run from the repo root, which is exactly how such a value used to survive
// into the project list and reach projectStateDir.

async function mkProjectsDir(rows) {
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-projects-'));
  tmpDirs.push(projectsDir);
  for (const [slug, cwd] of Object.entries(rows)) {
    const dir = path.join(projectsDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ cwd })}\n`, 'utf8');
  }
  return projectsDir;
}

test('a transcript recording a RELATIVE cwd never enters the project list', async () => {
  const projectsDir = await mkProjectsDir({ relative: 'src/main/lib' });
  // Sanity: the bad value really would have passed the old existence check.
  expect(fs.existsSync('src/main/lib')).toBe(true);

  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds).not.toContain('src/main/lib');
  expect(cwds).toEqual([]);
});

test('an absolute cwd that exists is still collected', async () => {
  const real = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-real-'));
  tmpDirs.push(real);
  const projectsDir = await mkProjectsDir({ good: real });

  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds).toContain(real);
});

test('an absolute cwd pointing at a FILE (not a directory) is rejected — a file is not a project', async () => {
  const holder = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-file-'));
  tmpDirs.push(holder);
  const filePath = path.join(holder, 'not-a-dir.txt');
  fs.writeFileSync(filePath, 'x', 'utf8');
  const projectsDir = await mkProjectsDir({ afile: filePath });

  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds).not.toContain(filePath);
});

test('an absolute cwd that no longer exists on disk is rejected', async () => {
  const projectsDir = await mkProjectsDir({ gone: path.join(os.tmpdir(), 'sm-opsroot-definitely-not-here-12345') });

  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds).toEqual([]);
});

test('the guards compose: no relative cwd from a transcript can reach an ops-root write', async () => {
  const projectsDir = await mkProjectsDir({ relative: 'src/renderer/state', alsoRelative: './src/main' });
  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds).toEqual([]);
  // And even if one somehow did, the write path itself refuses it.
  expect(() => queueStore.projectStateDir('src/renderer/state')).toThrow(/absolute path/);
});

// ─── the second incident: an ABSOLUTE cwd INSIDE an ops root ────────────────
//
// Reported from starry-night-ships on 2026-08-30: 14 stray
// `.../session-manager-operations/scheduler/state/queue.json` stubs, each
// nested under another ops directory (`scheduler/prds/`, `prompt-sessions/`,
// `scheduler/epics/<id>/prds/`), every one holding `{"jobs": []}` and mtimes
// spanning 8 days. The 2026-08-13 absolute-path guard above could not catch
// them: these cwds ARE absolute and DO exist. They came from transcripts
// where an agent had `cd`'d into the artifact directory it was writing, so
// the last transcript row recorded that subdirectory as the session cwd.

test('a transcript cwd inside an ops root is normalized to the project root, not taken literally', async () => {
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-nested-'));
  tmpDirs.push(project);
  const prdDir = path.join(project, 'session-manager-operations', 'scheduler', 'epics', 'e-1', 'prds');
  fs.mkdirSync(prdDir, { recursive: true });
  const projectsDir = await mkProjectsDir({ nested: prdDir });

  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds).toContain(project);
  expect(cwds).not.toContain(prdDir);
});

test('normalization keeps the active-project signal rather than dropping the row', () => {
  const { projectRootOf } = require('../../../../scripts/lib/activeSessions.cjs');
  expect(projectRootOf('/p/session-manager-operations/prompt-sessions')).toBe('/p');
  expect(projectRootOf('/p/session-manager-operations')).toBe('/p');
  expect(projectRootOf('/p/session-manager-operations/scheduler/state')).toBe('/p');
  // Already-nested strays truncate at the FIRST segment — the inner one is
  // itself the bug, never a project.
  expect(projectRootOf('/p/session-manager-operations/x/session-manager-operations/y')).toBe('/p');
  // A plain project cwd is untouched.
  expect(projectRootOf('/p/src/main')).toBe('/p/src/main');
  // A directory that merely CONTAINS the name as a substring is not a segment.
  expect(projectRootOf('/p/session-manager-operations-archive')).toBe('/p/session-manager-operations-archive');
});

test('projectStateDir fails closed on an ops-internal cwd, naming the offending value', () => {
  expect(() => queueStore.projectStateDir('/p/session-manager-operations/scheduler/prds'))
    .toThrow(/must be a project root/);
  expect(() => queueStore.projectStateDir('/p/session-manager-operations/scheduler/prds'))
    .toThrow(/scheduler\/prds/);
  // The guard is segment-exact, not a substring match.
  expect(queueStore.projectStateDir('/p/session-manager-operations-archive'))
    .toBe(path.join('/p/session-manager-operations-archive', 'session-manager-operations', 'scheduler', 'state'));
});

// The writeSplit half of this guard lives in opsRootNestedWrite.test.cjs —
// it must override HOME before requiring queueStore (writeSplit persists
// machine state to a homedir path), which cannot be done from this file.

// ─── the third incident: a cwd INSIDE a linked git worktree ─────────────────
//
// Verified live 2026-09-01 in starry-night-ships: a transcript's last `cwd`
// row pointed at `/tmp/session-manager-epic-worktrees/<hash>/<epicId>` — an
// absolute, existing directory, so it was accepted as a project and the real
// project root (`/home/bilko/Projects/starry-night-ships`) never entered the
// list at all. `worktreeMainRootOf` reverses a linked worktree's `.git` FILE
// (`gitdir: <main>/.git/worktrees/<name>`) back to `<main>`.

const { worktreeMainRootOf } = require('../../../../scripts/lib/activeSessions.cjs');
const { KIND_CONFIG: WORKTREE_KIND_CONFIG } = require('../gitWorktree.cjs');

// A worktree's MAIN tree root must live outside os.tmpdir() for these fixtures
// to double as a realistic "real project" for the tmp-drop-guard tests below
// (a real project is never itself under /tmp — only the linked worktree is).
// `test-results/` is already gitignored in this repo.
const NON_TMP_SCRATCH_ROOT = path.join(process.cwd(), 'test-results', 'opsroot-fixtures');

async function mkNonTmpDir(prefix) {
  fs.mkdirSync(NON_TMP_SCRATCH_ROOT, { recursive: true });
  return fsp.mkdtemp(path.join(NON_TMP_SCRATCH_ROOT, prefix));
}

async function makeWorktreeFixture() {
  const main = await mkNonTmpDir('sm-opsroot-main-');
  tmpDirs.push(main);
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  const worktree = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-worktree-'));
  tmpDirs.push(worktree);
  const worktreeName = 'sm-epic-abc123';
  const worktreeGitFile = path.join(worktree, '.git');
  const adminDir = path.join(main, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(adminDir, { recursive: true });
  // Real `git worktree add` writes this back-reference (the admin dir's own
  // `gitdir` file points at the linked worktree's `.git` FILE) — required by
  // worktreeMainRootOf's round-trip check so a crafted `.git` file elsewhere
  // on disk can't redirect resolution to an arbitrary directory.
  fs.writeFileSync(path.join(adminDir, 'gitdir'), `${worktreeGitFile}\n`, 'utf8');
  fs.writeFileSync(worktreeGitFile, `gitdir: ${adminDir}\n`, 'utf8');
  return { main, worktree };
}

test('worktreeMainRootOf resolves a linked worktree .git FILE back to the main tree root', async () => {
  const { main, worktree } = await makeWorktreeFixture();
  expect(worktreeMainRootOf(worktree)).toBe(main);
});

test('worktreeMainRootOf returns the ancestor unchanged when .git is a real directory', async () => {
  const main = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-plain-main-'));
  tmpDirs.push(main);
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  const nested = path.join(main, 'src', 'main', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  expect(worktreeMainRootOf(nested)).toBe(main);
});

test('worktreeMainRootOf returns null on a garbled .git file instead of throwing', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-garbled-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, '.git'), 'not a gitdir line at all', 'utf8');
  expect(worktreeMainRootOf(dir)).toBeNull();

  const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-garbled2-'));
  tmpDirs.push(dir2);
  fs.writeFileSync(path.join(dir2, '.git'), 'gitdir: /some/path/without/the/marker\n', 'utf8');
  expect(worktreeMainRootOf(dir2)).toBeNull();
});

test('worktreeMainRootOf refuses a crafted .git file that redirects to an arbitrary directory with no back-reference', async () => {
  // A `.git` FILE is an ordinary file — nothing stops an untrusted repo from
  // shipping one at a nested path pointing anywhere. Without verifying the
  // admin dir's own `gitdir` back-reference, this would let a crafted repo
  // redirect activeSessions' project-root resolution (and therefore
  // queueStore's ops-root writes) to an attacker-chosen absolute directory.
  const arbitraryTarget = await mkNonTmpDir('sm-opsroot-arbitrary-target-');
  tmpDirs.push(arbitraryTarget);
  const attackerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-attacker-'));
  tmpDirs.push(attackerDir);
  // No admin dir/back-reference file exists under arbitraryTarget/.git/worktrees/.
  fs.writeFileSync(
    path.join(attackerDir, '.git'),
    `gitdir: ${path.join(arbitraryTarget, '.git', 'worktrees', 'x')}\n`,
    'utf8',
  );
  expect(worktreeMainRootOf(attackerDir)).toBeNull();
});

test('worktreeMainRootOf refuses a crafted .git file whose admin dir exists but back-references a DIFFERENT worktree', async () => {
  const { main } = await makeWorktreeFixture();
  const attackerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-attacker2-'));
  tmpDirs.push(attackerDir);
  // Points at a REAL admin dir (main's own), but that admin dir's gitdir
  // back-reference points at the ORIGINAL worktree, not attackerDir.
  fs.writeFileSync(
    path.join(attackerDir, '.git'),
    `gitdir: ${path.join(main, '.git', 'worktrees', 'sm-epic-abc123')}\n`,
    'utf8',
  );
  expect(worktreeMainRootOf(attackerDir)).toBeNull();
});

test('worktreeMainRootOf returns null for a plain non-git directory', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-nogit-'));
  tmpDirs.push(dir);
  expect(worktreeMainRootOf(dir)).toBeNull();
});

test('projectRootOf resolves a worktree cwd to the main tree root', async () => {
  const { main, worktree } = await makeWorktreeFixture();
  const { projectRootOf } = require('../../../../scripts/lib/activeSessions.cjs');
  expect(projectRootOf(worktree)).toBe(main);
});

test('projectRootOf resolves a cwd nested inside a worktree\'s OWN ops tree to the main root', async () => {
  const { main, worktree } = await makeWorktreeFixture();
  const { projectRootOf } = require('../../../../scripts/lib/activeSessions.cjs');
  const nestedOps = path.join(worktree, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(nestedOps, { recursive: true });
  expect(projectRootOf(nestedOps)).toBe(main);
});

test('activeProjectCwds resolves a worktree cwd to the real project and drops unresolvable tmp cwds', async () => {
  const { main, worktree } = await makeWorktreeFixture();
  // A bare, .git-less directory directly under the managed epic-worktree
  // root — the shape a torn-down or mid-teardown worktree leaves behind.
  // worktreeMainRootOf can't resolve it (no .git), so only the drop-guard's
  // prefixDropRoots check keeps it out of the project list.
  fs.mkdirSync(WORKTREE_KIND_CONFIG.epic.root, { recursive: true });
  const bareWorktreeRoot = await fsp.mkdtemp(path.join(WORKTREE_KIND_CONFIG.epic.root, 'sm-opsroot-bare-'));
  tmpDirs.push(bareWorktreeRoot);
  const projectsDir = await mkProjectsDir({
    resolvable: worktree,
    unresolvable: bareWorktreeRoot,
    bareTmpdir: os.tmpdir(),
  });

  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds).toContain(main);
  expect(cwds).not.toContain(worktree);
  expect(cwds).not.toContain(bareWorktreeRoot);
  expect(cwds).not.toContain(os.tmpdir());
});

test('a main-tree root resolved from a worktree dedupes against a directly-observed cwd for the same project', async () => {
  const { main, worktree } = await makeWorktreeFixture();
  const projectsDir = await mkProjectsDir({ direct: main, viaWorktree: worktree });

  const cwds = activeProjectCwds(Infinity, { projectsDir });
  expect(cwds.filter((c) => c === main)).toHaveLength(1);
});
