/**
 * prdLocations.test.cjs — unit tests for prdLocations.cjs's per-project PRD
 * directory resolution (PRD 808).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdLocations.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolvePrdWriteDir, resolvePrdsDirs } = require('../lib/prdLocations.cjs');

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
