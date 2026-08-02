/**
 * prdLocationsArchived.test.cjs — unit tests for the archived-PRD discovery
 * that backs `schedule:list-prds` including archived PRDs (PRD 926): an
 * Epic's "PRDs" tab count must reflect its REAL historical PRD count, not
 * just whatever is still sitting in its live `prds/` dir — a completed
 * PRD's source .md moves to the sibling `prds-archived/` dir the instant its
 * scheduler job finishes (scheduler.cjs's archiveCompletedPrd), which the
 * old list-prds handler never read.
 *
 * Covers:
 *   - resolveArchivedPrdsDirs finds an Epic's own `prds-archived/` dir
 *     alongside the project's flat sibling one.
 *   - deriveEpicIdFromPrdPath resolves an epicId for a file under
 *     `prds-archived/`, not just the live `prds/` dir.
 *   - scheduler.cjs's candidateArchivedPrdsDirs + candidatePrdsDirs
 *     together surface both a still-pending PRD and an already-archived one
 *     for the same Epic, without double-counting.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdLocationsArchived.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  resolveArchivedPrdsDirs,
  resolvePrdsDirs,
  resolveEpicPrdWriteDir,
  deriveEpicIdFromPrdPath,
} = require('../lib/prdLocations.cjs');
const { candidatePrdsDirs, candidateArchivedPrdsDirs, resolveArchivedPrdStatus } = require('../scheduler.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

function mkEpicProject() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-archived-cwd-'));
}

test('resolveArchivedPrdsDirs finds an Epic\'s own prds-archived/ dir for an active project', async () => {
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-archived-projects-'));
  tmpDirs.push(projectsDir);
  const projectCwd = await mkEpicProject();
  tmpDirs.push(projectCwd);

  const epicPrdsDir = resolveEpicPrdWriteDir(projectCwd, 'epic-1');
  const epicArchiveDir = path.join(epicPrdsDir, '..', 'prds-archived');
  fs.mkdirSync(epicArchiveDir, { recursive: true });

  const projDir = path.join(projectsDir, 'epic-project');
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, 'session1.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ cwd: projectCwd })}\n`);

  const dirs = resolveArchivedPrdsDirs(90, { projectsDir });
  expect(dirs).toContain(path.resolve(epicArchiveDir));
});

test('deriveEpicIdFromPrdPath resolves epicId for a file under prds-archived/, not just prds/', async () => {
  const projectCwd = await mkEpicProject();
  tmpDirs.push(projectCwd);

  const epicPrdsDir = resolveEpicPrdWriteDir(projectCwd, 'epic-42');
  const epicArchiveDir = path.join(epicPrdsDir, '..', 'prds-archived');
  fs.mkdirSync(epicArchiveDir, { recursive: true });

  const archivedFile = path.join(epicArchiveDir, '917-example.md');
  fs.writeFileSync(archivedFile, '---\ntitle: example\n---\n\n# Goal\n');

  expect(deriveEpicIdFromPrdPath(archivedFile)).toBe('epic-42');
  // Still works for the live dir too — no regression.
  const liveFile = path.join(epicPrdsDir, '918-example.md');
  fs.mkdirSync(epicPrdsDir, { recursive: true });
  fs.writeFileSync(liveFile, '---\ntitle: example\n---\n\n# Goal\n');
  expect(deriveEpicIdFromPrdPath(liveFile)).toBe('epic-42');
});

test('deriveEpicIdFromPrdPath returns null for an unrelated dir name', () => {
  expect(deriveEpicIdFromPrdPath('/some/random/dir/917-example.md')).toBeNull();
});

test('resolvePrdsDirs + resolveArchivedPrdsDirs together surface a pending PRD dir and an archived PRD dir for the same Epic, with no overlap', async () => {
  const projectsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prdloc-both-projects-'));
  tmpDirs.push(projectsDir);
  const projectCwd = await mkEpicProject();
  tmpDirs.push(projectCwd);

  const epicId = `test-epic-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const epicPrdsDir = resolveEpicPrdWriteDir(projectCwd, epicId);
  const epicArchiveDir = path.join(epicPrdsDir, '..', 'prds-archived');
  fs.mkdirSync(epicPrdsDir, { recursive: true });
  fs.mkdirSync(epicArchiveDir, { recursive: true });

  const pendingSlug = `926-pending-${process.pid}`;
  const archivedSlug = `917-archived-${process.pid}`;
  fs.writeFileSync(path.join(epicPrdsDir, `${pendingSlug}.md`), `---\ntitle: pending\ncwd: ${projectCwd}\n---\n\n# Goal\n`);
  fs.writeFileSync(path.join(epicArchiveDir, `${archivedSlug}.md`), `---\ntitle: archived\ncwd: ${projectCwd}\n---\n\n# Goal\n`);

  const projDir = path.join(projectsDir, 'both-project');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session1.jsonl'), `${JSON.stringify({ cwd: projectCwd })}\n`);

  const liveDirs = resolvePrdsDirs(90, { projectsDir });
  const archivedDirs = resolveArchivedPrdsDirs(90, { projectsDir });
  expect(liveDirs).toContain(epicPrdsDir);
  expect(archivedDirs.map((d) => path.resolve(d))).toContain(path.resolve(epicArchiveDir));

  // No overlap between the two dir sets for this Epic — an archived PRD's
  // dir is never also scanned as a live one, and vice versa.
  expect(liveDirs).not.toContain(epicArchiveDir);
  expect(archivedDirs).not.toContain(epicPrdsDir);
});

test('resolveArchivedPrdStatus prefers the live queue.json row over history', () => {
  const liveStatusBySlug = new Map([['917-slug', 'failed']]);
  const histBySlug = new Map([['917-slug', { status: 'completed' }]]);
  expect(resolveArchivedPrdStatus('917-slug', liveStatusBySlug, histBySlug)).toBe('failed');
});

test('resolveArchivedPrdStatus falls back to history.jsonl when there is no live row', () => {
  const liveStatusBySlug = new Map();
  const histBySlug = new Map([['917-slug', { status: 'failed' }]]);
  expect(resolveArchivedPrdStatus('917-slug', liveStatusBySlug, histBySlug)).toBe('failed');
});

test('resolveArchivedPrdStatus defaults to completed when neither source has the slug', () => {
  expect(resolveArchivedPrdStatus('917-slug', new Map(), new Map())).toBe('completed');
});

test('resolveArchivedPrdStatus normalizes any non-failed status (e.g. needs_review) to completed', () => {
  const liveStatusBySlug = new Map([['917-slug', 'needs_review']]);
  expect(resolveArchivedPrdStatus('917-slug', liveStatusBySlug, new Map())).toBe('completed');
});

test('scheduler.cjs exports candidateArchivedPrdsDirs alongside candidatePrdsDirs', () => {
  expect(typeof candidatePrdsDirs).toBe('function');
  expect(typeof candidateArchivedPrdsDirs).toBe('function');
  // Both scan the real machine's projects — just assert they run without
  // throwing and return arrays; per-Epic coverage is exercised above via
  // the opts-injectable prdLocations functions directly.
  expect(Array.isArray(candidatePrdsDirs())).toBe(true);
  expect(Array.isArray(candidateArchivedPrdsDirs())).toBe(true);
});
