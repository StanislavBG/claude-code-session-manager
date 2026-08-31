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
