/**
 * epic-ancestor-prd-lookup.test.cjs — regression cover for the "Epic lives
 * in a non-git PARENT folder" incident: an Epic's PRDs live under
 * `P/session-manager-operations/scheduler/epics/<epicId>/prds/*.md` while
 * the PRDs' own frontmatter `cwd` points at a SUB-REPO `P/repo`. Because `P`
 * is never itself a tracked project cwd, the ordinary global PRD-dir search
 * (findPrdDir/candidatePrdsDirs) never visits it, and dispatch wrongly
 * retired the job as `prd-missing` (prdArchivedSkipResult /
 * archivedTwinExists, `spawnJob:skip-archived`).
 *
 * Covers:
 *  - prdLocations.ancestorEpicPrdDirs / ancestorEpicArchivedPrdDirs walk up
 *    from a sub-repo cwd to find the EXACT epicId's prds / prds-archived dir
 *    in an ancestor folder (bounded hops, exact-match, path.join only).
 *  - scheduler.findPrdDirForJob resolves the live PRD through that ancestor
 *    walk (job not skipped, PRD found).
 *  - scheduler.archivedTwinExists resolves an archived twin the same way.
 *  - A genuinely missing PRD (no live file, no archived twin, anywhere) is
 *    still not found — same "skip as stale" outcome as before this fix.
 *  - epicId containing a path separator or '..' is rejected outright, never
 *    used as a glob or string-concatenated into a path.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epic-ancestor-prd-lookup.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ancestorEpicPrdDirs, ancestorEpicArchivedPrdDirs } = require('../lib/prdLocations.cjs');
const { findPrdDirForJob, archivedTwinExists } = require('../scheduler.cjs');

const tmpDirs = [];

/** Builds a `<parent>/repo` layout: parent is the non-git Epic-owning
 * folder, repo is the sub-repo a PRD's frontmatter `cwd` points at. */
function makeParentRepoFixture() {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-ancestor-parent-'));
  tmpDirs.push(parentDir);
  const repoDir = path.join(parentDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  return { parentDir, repoDir };
}

function epicPrdsDir(parentDir, epicId) {
  return path.join(parentDir, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
}
function epicArchivedDir(parentDir, epicId) {
  return path.join(parentDir, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds-archived');
}

function uniqueSlug(label) {
  return `epic-ancestor-${label}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ancestorEpicPrdDirs finds the exact epicId prds dir one level above cwd', () => {
  const { parentDir, repoDir } = makeParentRepoFixture();
  const epicId = 'clone-latest-from-source-project-git-update-repo-700199c5';
  const prdsDir = epicPrdsDir(parentDir, epicId);
  fs.mkdirSync(prdsDir, { recursive: true });

  expect(ancestorEpicPrdDirs(repoDir, epicId)).toEqual([prdsDir]);
});

test('ancestorEpicPrdDirs returns [] for an unrelated epicId (exact match only, never a glob)', () => {
  const { parentDir, repoDir } = makeParentRepoFixture();
  fs.mkdirSync(epicPrdsDir(parentDir, 'real-epic'), { recursive: true });

  expect(ancestorEpicPrdDirs(repoDir, 'real-epic-but-not-quite')).toEqual([]);
  expect(ancestorEpicPrdDirs(repoDir, 'different-epic')).toEqual([]);
});

test('ancestorEpicPrdDirs rejects an epicId containing a path separator or ".."', () => {
  const { parentDir, repoDir } = makeParentRepoFixture();
  fs.mkdirSync(epicPrdsDir(parentDir, 'safe-epic'), { recursive: true });

  expect(ancestorEpicPrdDirs(repoDir, '../safe-epic')).toEqual([]);
  expect(ancestorEpicPrdDirs(repoDir, 'safe-epic/../../etc')).toEqual([]);
  expect(ancestorEpicPrdDirs(repoDir, 'nested/segment')).toEqual([]);
});

test('ancestorEpicPrdDirs gives up beyond the 3-parent hop bound', () => {
  const { parentDir, repoDir } = makeParentRepoFixture();
  const epicId = 'too-far-up';
  // Push the sub-repo 4 levels below the epic's real ancestor.
  const deepCwd = path.join(repoDir, 'a', 'b', 'c', 'd');
  fs.mkdirSync(deepCwd, { recursive: true });
  fs.mkdirSync(epicPrdsDir(parentDir, epicId), { recursive: true });

  expect(ancestorEpicPrdDirs(deepCwd, epicId)).toEqual([]);
});

test('findPrdDirForJob resolves a job whose PRD lives in the Epic-owning PARENT folder, not job.cwd', async () => {
  const { parentDir, repoDir } = makeParentRepoFixture();
  const epicId = 'clone-latest-from-source-project-git-update-repo-700199c5';
  const slug = uniqueSlug('live');
  const prdsDir = epicPrdsDir(parentDir, epicId);
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(
    path.join(prdsDir, `${slug}.md`),
    '---\ntitle: ancestor-epic fixture\ncwd: ' + repoDir + '\n---\n\n# Goal\n\ntest\n',
    'utf8',
  );

  const job = { slug, cwd: repoDir, epicId };
  const resolvedDir = await findPrdDirForJob(job);
  expect(resolvedDir).toBe(prdsDir);
});

test('findPrdDirForJob returns null for a genuinely missing PRD (still treated as stale, same as before)', async () => {
  const { repoDir } = makeParentRepoFixture();
  const job = { slug: uniqueSlug('missing'), cwd: repoDir, epicId: 'clone-latest-from-source-project-git-update-repo-700199c5' };

  expect(await findPrdDirForJob(job)).toBe(null);
});

test('findPrdDirForJob honors a stored absolute prdPath on the row even outside the ancestor walk', async () => {
  const { repoDir } = makeParentRepoFixture();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-ancestor-elsewhere-'));
  tmpDirs.push(elsewhere);
  const slug = uniqueSlug('stored-path');
  const storedPath = path.join(elsewhere, `${slug}.md`);
  fs.writeFileSync(storedPath, '---\ntitle: stored-path fixture\n---\n\n# Goal\n\ntest\n', 'utf8');

  const job = { slug, cwd: repoDir, epicId: 'unrelated-epic', prdPath: storedPath };
  expect(await findPrdDirForJob(job)).toBe(elsewhere);
});

test('archivedTwinExists finds an archived twin in the Epic-owning PARENT folder via the ancestor walk', async () => {
  const { parentDir, repoDir } = makeParentRepoFixture();
  const epicId = 'clone-latest-from-source-project-git-update-repo-700199c5';
  const slug = uniqueSlug('archived');
  const archiveDir = epicArchivedDir(parentDir, epicId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, `${slug}.md`), '# Goal\n\nshipped\n', 'utf8');

  await expect(archivedTwinExists({ slug, cwd: repoDir, epicId })).resolves.toBe(true);
});

test('archivedTwinExists returns false when a genuinely missing PRD has no archived twin anywhere', async () => {
  const { repoDir } = makeParentRepoFixture();
  const slug = uniqueSlug('no-twin');

  await expect(
    archivedTwinExists({ slug, cwd: repoDir, epicId: 'clone-latest-from-source-project-git-update-repo-700199c5' }),
  ).resolves.toBe(false);
});

test('ancestorEpicArchivedPrdDirs never matches a different Epic sharing the same parent folder', () => {
  const { parentDir, repoDir } = makeParentRepoFixture();
  fs.mkdirSync(epicArchivedDir(parentDir, 'epic-a'), { recursive: true });

  expect(ancestorEpicArchivedPrdDirs(repoDir, 'epic-b')).toEqual([]);
});
