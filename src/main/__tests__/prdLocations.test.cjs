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
