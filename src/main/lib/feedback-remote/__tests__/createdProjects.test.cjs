/**
 * createdProjects.test.cjs — store of project folders created by project_create.
 *
 * Run: timeout 180 npx vitest run src/main/lib/feedback-remote/__tests__/createdProjects.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCreatedProjects,
  getCreatedProjects,
  __resetCreatedProjectsForTests,
  MAX_PROJECTS,
} = require('../createdProjects.cjs');

let tmp;
let file;
let prevEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'created-projects-'));
  file = path.join(tmp, 'sm', 'created-projects.json');
  prevEnv = process.env.SM_CREATED_PROJECTS_FILE;
  __resetCreatedProjectsForTests();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.SM_CREATED_PROJECTS_FILE;
  else process.env.SM_CREATED_PROJECTS_FILE = prevEnv;
  __resetCreatedProjectsForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FROM = '/home/u/Self';

test('record + findByRef + findByCwd round trip across a fresh store on the same file', async () => {
  let t = 1000;
  const a = createCreatedProjects({ filePath: file, now: () => t });
  const rec = await a.record({ cwd: '/home/u/Projects/foo/../bar', fromCwd: FROM + '/', externalRef: 'idea-1' });
  expect(rec).toEqual({ cwd: '/home/u/Projects/bar', fromCwd: FROM, externalRef: 'idea-1', repo: null, createdAt: 1000 });

  const b = createCreatedProjects({ filePath: file });
  expect(b.findByRef(FROM, 'idea-1')).toEqual(rec);
  expect(b.findByRef('/home/u/Self/', 'idea-1')).toEqual(rec);
  expect(b.findByCwd('/home/u/Projects/bar')).toEqual(rec);
  expect(b.findByRef(FROM, 'other')).toBeNull();
  expect(b.findByRef('/elsewhere', 'idea-1')).toBeNull();
  expect(b.findByCwd('/home/u/Projects/none')).toBeNull();
  expect(b.findByCwd('relative')).toBeNull();
  expect(b.list()).toEqual([rec]);

  // returned objects are copies
  b.findByCwd('/home/u/Projects/bar').cwd = '/mutated';
  expect(b.findByCwd('/home/u/Projects/bar').cwd).toBe('/home/u/Projects/bar');
});

test('repeat record of the same (fromCwd, externalRef, cwd) returns the existing entry', async () => {
  let t = 1;
  const s = createCreatedProjects({ filePath: file, now: () => t++ });
  const first = await s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r', repo: 'me/a' });
  const again = await s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r' });
  expect(again).toEqual(first);
  expect(s.list()).toHaveLength(1);
});

test('record rejects bad input and conflicts', async () => {
  const s = createCreatedProjects({ filePath: file });
  await expect(s.record({ cwd: 'rel/path', fromCwd: FROM, externalRef: 'r' })).rejects.toThrow(/cwd/);
  await expect(s.record({ cwd: '/p/a', fromCwd: 'rel', externalRef: 'r' })).rejects.toThrow(/fromCwd/);
  await expect(s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: '' })).rejects.toThrow(/externalRef/);
  await expect(s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'x'.repeat(201) })).rejects.toThrow(/externalRef/);
  await expect(s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r', repo: 5 })).rejects.toThrow(/repo/);
  // 200 chars is fine
  await s.record({ cwd: '/p/long', fromCwd: FROM, externalRef: 'x'.repeat(200) });

  await s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r1' });
  // second externalRef for an already-recorded cwd
  await expect(s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r2' })).rejects.toThrow(/already recorded/);
  // already-used (fromCwd, externalRef) naming a different cwd
  await expect(s.record({ cwd: '/p/b', fromCwd: FROM, externalRef: 'r1' })).rejects.toThrow(/already names/);
  // same ref from another fromCwd is a different pair
  await s.record({ cwd: '/p/c', fromCwd: '/home/u/Other', externalRef: 'r1' });
  expect(s.list().map((e) => e.cwd).sort()).toEqual(['/p/a', '/p/c', '/p/long']);
});

test('setRepo updates the entry and persists', async () => {
  const s = createCreatedProjects({ filePath: file });
  await s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r' });
  const upd = await s.setRepo('/p/a', 'me/a');
  expect(upd.repo).toBe('me/a');
  expect(await s.setRepo('/p/none', 'me/x')).toBeNull();
  await expect(s.setRepo('/p/a', '')).rejects.toThrow(/repo/);
  await expect(s.setRepo('rel', 'me/a')).rejects.toThrow(/cwd/);
  expect(createCreatedProjects({ filePath: file }).findByCwd('/p/a').repo).toBe('me/a');
});

test('keeps the newest 1000 entries; list is newest first', async () => {
  let t = 0;
  const s = createCreatedProjects({ filePath: file, now: () => ++t });
  for (let i = 0; i < MAX_PROJECTS + 5; i++) {
    await s.record({ cwd: `/p/n${i}`, fromCwd: FROM, externalRef: `r${i}` });
  }
  expect(MAX_PROJECTS).toBe(1000);
  const fresh = createCreatedProjects({ filePath: file });
  const all = fresh.list();
  expect(all).toHaveLength(1000);
  expect(all[0].cwd).toBe(`/p/n${MAX_PROJECTS + 4}`);
  expect(all[999].cwd).toBe('/p/n5');
  expect(fresh.findByCwd('/p/n4')).toBeNull();
});

test('missing and corrupt files load as empty', async () => {
  expect(createCreatedProjects({ filePath: file }).list()).toEqual([]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const s = createCreatedProjects({ filePath: file });
  expect(s.list()).toEqual([]);
  await s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r' });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(parsed.version).toBe(1);
  expect(parsed.projects).toHaveLength(1);
  // malformed entries are dropped
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [null, { cwd: 3 }, { cwd: '/p/ok', fromCwd: FROM, externalRef: 'k', repo: null, createdAt: 1 }] }));
  expect(createCreatedProjects({ filePath: file }).list().map((e) => e.cwd)).toEqual(['/p/ok']);
});

test('file is written with mode 0600', async () => {
  const s = createCreatedProjects({ filePath: file });
  await s.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r' });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test('getCreatedProjects caches one instance on SM_CREATED_PROJECTS_FILE', async () => {
  process.env.SM_CREATED_PROJECTS_FILE = file;
  const a = getCreatedProjects();
  expect(getCreatedProjects()).toBe(a);
  await a.record({ cwd: '/p/a', fromCwd: FROM, externalRef: 'r' });
  expect(fs.existsSync(file)).toBe(true);
  __resetCreatedProjectsForTests();
  const b = getCreatedProjects();
  expect(b).not.toBe(a);
  expect(b.findByRef(FROM, 'r').cwd).toBe('/p/a');
});
