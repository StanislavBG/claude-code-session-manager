/**
 * prdLocations.test.cjs — unit tests for prdLocations.cjs's per-project PRD
 * directory resolution (PRD 808).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdLocations.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  resolvePrdWriteDir,
  resolvePrdsDirs,
  resolveEpicPrdWriteDir,
  listEpicPrdDirs,
} = require('../lib/prdLocations.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

test('resolvePrdWriteDir joins the project-scoped PRDs subpath onto cwd', () => {
  expect(resolvePrdWriteDir('/home/user/Projects/foo')).toBe(
    path.join('/home/user/Projects/foo', 'session-manager-operations', 'scheduler', 'prds'),
  );
});

test('resolvePrdWriteDir throws on a missing cwd', () => {
  expect(() => resolvePrdWriteDir()).toThrow();
  expect(() => resolvePrdWriteDir('')).toThrow();
});

test('resolvePrdsDirs still finds a QUIET project\'s PRDs dir (no recency filter)', async () => {
  // Regression cover for 2026-07-31: discovery used activeProjectCwds' 90-min
  // window, so a project nobody had touched recently became unscannable — and
  // reconcile() reads an unscannable PRD as a deleted one and drops its queue
  // row. 142 PRDs across 6 quiet projects were affected.
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-quiet-projects-'));
  tmpDirs.push(projectsDir);
  const quietCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-quiet-cwd-'));
  tmpDirs.push(quietCwd);

  // The project owns a real PRDs dir on disk...
  fs.mkdirSync(resolvePrdWriteDir(quietCwd), { recursive: true });

  const projDir = path.join(projectsDir, 'quiet-project');
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, 'session1.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ cwd: quietCwd })}\n`);
  // ...but its last session was a week ago, far outside the active window.
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  fs.utimesSync(transcript, weekAgo, weekAgo);

  const dirs = resolvePrdsDirs(90, { projectsDir });
  expect(dirs).toContain(resolvePrdWriteDir(quietCwd));
});

test('resolvePrdsDirs skips a quiet project that owns no PRDs dir', async () => {
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-nodir-projects-'));
  tmpDirs.push(projectsDir);
  const quietCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-nodir-cwd-'));
  tmpDirs.push(quietCwd);

  const projDir = path.join(projectsDir, 'quiet-no-prds');
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, 'session1.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ cwd: quietCwd })}\n`);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  fs.utimesSync(transcript, weekAgo, weekAgo);

  expect(resolvePrdsDirs(90, { projectsDir })).not.toContain(resolvePrdWriteDir(quietCwd));
});

test('resolvePrdsDirs maps each active project cwd to its own PRDs dir', async () => {
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdlocations-projects-'));
  tmpDirs.push(projectsDir);
  const projectCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdlocations-cwd-'));
  tmpDirs.push(projectCwd);

  const slug = 'abc123';
  const projDir = path.join(projectsDir, slug);
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, 'session1.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ cwd: projectCwd })}\n`);

  const dirs = resolvePrdsDirs(90, { projectsDir });
  expect(dirs).toEqual([resolvePrdWriteDir(projectCwd)]);
  expect(dirs[0].endsWith(path.join('session-manager-operations', 'scheduler', 'prds'))).toBe(true);
});

test('resolvePrdsDirs returns [] when no project has a recent transcript', () => {
  const dirs = resolvePrdsDirs(90, { projectsDir: '/nonexistent-projects-dir' });
  expect(dirs).toEqual([]);
});

test('listEpicPrdDirs memoizes on the Epics-root mtime: no readdir on a repeat call, but a freshly minted Epic prds dir is picked up on the very next call', async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-memo-cwd-'));
  tmpDirs.push(cwd);
  fs.mkdirSync(resolveEpicPrdWriteDir(cwd, 'epic-1'), { recursive: true });

  const first = listEpicPrdDirs(cwd);
  expect(first).toEqual([resolveEpicPrdWriteDir(cwd, 'epic-1')]);

  const readdirSpy = vi.spyOn(fs, 'readdirSync');
  try {
    // Nothing under the Epics root changed — the cached result comes back
    // without a fresh readdir of the Epics root.
    const second = listEpicPrdDirs(cwd);
    expect(second).toEqual(first);
    expect(readdirSpy).not.toHaveBeenCalled();
  } finally {
    readdirSpy.mockRestore();
  }

  // A brand-new Epic's prds/ dir is a NEW entry under the Epics root, which
  // bumps the root's own mtime — no TTL wait required to see it.
  fs.mkdirSync(resolveEpicPrdWriteDir(cwd, 'epic-2'), { recursive: true });
  const third = listEpicPrdDirs(cwd);
  expect(third).toEqual(
    expect.arrayContaining([resolveEpicPrdWriteDir(cwd, 'epic-1'), resolveEpicPrdWriteDir(cwd, 'epic-2')]),
  );
});

test('listEpicPrdDirs: an unreadable Epics root does not write a poisoned entry that survives the dir becoming readable', async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-unreadable-cwd-'));
  tmpDirs.push(cwd);

  // No Epics root at all yet.
  expect(listEpicPrdDirs(cwd)).toEqual([]);

  // The root now exists, with a real Epic prds dir inside it.
  fs.mkdirSync(resolveEpicPrdWriteDir(cwd, 'epic-1'), { recursive: true });
  expect(listEpicPrdDirs(cwd)).toEqual([resolveEpicPrdWriteDir(cwd, 'epic-1')]);
});

test('resolvePrdsDirs EDGE (non-negotiable): a new epics/<id>/prds dir created after a prior call is visible on the VERY NEXT call, no TTL wait', async () => {
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-freshness-projects-'));
  tmpDirs.push(projectsDir);
  const projectCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-freshness-cwd-'));
  tmpDirs.push(projectCwd);

  const projDir = path.join(projectsDir, 'freshness-project');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session1.jsonl'), `${JSON.stringify({ cwd: projectCwd })}\n`);

  const before = resolvePrdsDirs(90, { projectsDir });
  const newEpicPrdDir = resolveEpicPrdWriteDir(projectCwd, 'freshly-minted-epic');
  expect(before).not.toContain(newEpicPrdDir);

  fs.mkdirSync(newEpicPrdDir, { recursive: true });

  const after = resolvePrdsDirs(90, { projectsDir });
  expect(after).toContain(newEpicPrdDir);
});

test('resolvePrdsDirs: calls with an explicit { projectsDir } opts are keyed separately per projectsDir and never share a stale cache entry', async () => {
  const projectsDirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-keyed-a-'));
  tmpDirs.push(projectsDirA);
  const projectsDirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-keyed-b-'));
  tmpDirs.push(projectsDirB);
  const cwdA = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-keyed-cwd-a-'));
  tmpDirs.push(cwdA);
  const cwdB = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-keyed-cwd-b-'));
  tmpDirs.push(cwdB);

  const projDirA = path.join(projectsDirA, 'proj-a');
  fs.mkdirSync(projDirA, { recursive: true });
  fs.writeFileSync(path.join(projDirA, 'session1.jsonl'), `${JSON.stringify({ cwd: cwdA })}\n`);
  fs.mkdirSync(resolvePrdWriteDir(cwdA), { recursive: true });

  const projDirB = path.join(projectsDirB, 'proj-b');
  fs.mkdirSync(projDirB, { recursive: true });
  fs.writeFileSync(path.join(projDirB, 'session1.jsonl'), `${JSON.stringify({ cwd: cwdB })}\n`);
  fs.mkdirSync(resolvePrdWriteDir(cwdB), { recursive: true });

  const dirsA = resolvePrdsDirs(90, { projectsDir: projectsDirA });
  const dirsB = resolvePrdsDirs(90, { projectsDir: projectsDirB });

  expect(dirsA).toContain(resolvePrdWriteDir(cwdA));
  expect(dirsA).not.toContain(resolvePrdWriteDir(cwdB));
  expect(dirsB).toContain(resolvePrdWriteDir(cwdB));
  expect(dirsB).not.toContain(resolvePrdWriteDir(cwdA));

  // Re-querying A after B was resolved must still reflect A's own state, not
  // B's — proof the two opts objects never shared one cache key.
  expect(resolvePrdsDirs(90, { projectsDir: projectsDirA })).toEqual(dirsA);
});
