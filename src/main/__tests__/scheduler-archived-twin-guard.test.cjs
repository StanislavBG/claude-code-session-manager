/**
 * scheduler-archived-twin-guard.test.cjs — unit tests for archivedTwinExists
 * (PRD 822-promptsession-prd-trace-events recurrence fix): a queue row whose
 * PRD `.md` has already been moved to the sibling `prds-archived/` dir (work
 * shipped out-of-band) must be recognized as stale, not a genuine missing-PRD
 * failure.
 *
 * Uses a temp cwd fixture (`prdDirForCwd` is a pure path join off `cwd`) so
 * this never touches the real `~/.claude/session-manager/` tree.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-archived-twin-guard.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { archivedTwinExists, archivedPrdPathForJob, prdDirForCwd } = require('../scheduler.cjs');
const { listArchivedPrdDirs } = require('../lib/prdLocations.cjs');

const tmpDirs = [];

function makeFixtureCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-archived-twin-'));
  tmpDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archivedTwinExists returns true when the archived twin exists and the live PRD does not', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-shipped-and-archived';
  const prdsDir = prdDirForCwd(cwd);
  const archivedDir = path.join(prdsDir, '..', 'prds-archived');
  fs.mkdirSync(archivedDir, { recursive: true });
  fs.writeFileSync(path.join(archivedDir, `${slug}.md`), '# Goal\n\nshipped\n', 'utf8');

  await expect(archivedTwinExists({ slug, cwd })).resolves.toBe(true);
});

test('archivedTwinExists returns false when neither the live PRD nor an archived twin exists', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-genuinely-missing';
  fs.mkdirSync(prdDirForCwd(cwd), { recursive: true });

  await expect(archivedTwinExists({ slug, cwd })).resolves.toBe(false);
});

test('archivedTwinExists returns false for a slug whose archived twin belongs to a different cwd', async () => {
  const cwd = makeFixtureCwd();
  const otherCwd = makeFixtureCwd();
  const slug = 'test-cross-cwd-twin';
  const otherArchivedDir = path.join(prdDirForCwd(otherCwd), '..', 'prds-archived');
  fs.mkdirSync(otherArchivedDir, { recursive: true });
  fs.writeFileSync(path.join(otherArchivedDir, `${slug}.md`), '# Goal\n\nother project\n', 'utf8');
  fs.mkdirSync(prdDirForCwd(cwd), { recursive: true });

  await expect(archivedTwinExists({ slug, cwd })).resolves.toBe(false);
});

test('archivedTwinExists returns false when the PRD is still live in prds/ (never short-circuits a normal run)', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-still-live';
  const prdsDir = prdDirForCwd(cwd);
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), '# Goal\n\nlive\n', 'utf8');

  await expect(archivedTwinExists({ slug, cwd })).resolves.toBe(false);
});

test('archivedPrdPathForJob resolves to the sibling prds-archived/<slug>.md for a job cwd', () => {
  const cwd = makeFixtureCwd();
  const job = { cwd, slug: 'my-slug' };
  const prdsDir = prdDirForCwd(cwd);
  const expected = path.join(prdsDir, '..', 'prds-archived', 'my-slug.md');
  expect(archivedPrdPathForJob(job)).toBe(expected);
});

test('archivedPrdPathForJob does not escape prds-archived/ for a well-formed slug', () => {
  const cwd = makeFixtureCwd();
  const job = { cwd, slug: 'well-formed-slug' };
  const resolved = path.resolve(archivedPrdPathForJob(job));
  const archiveDir = path.resolve(path.join(prdDirForCwd(cwd), '..', 'prds-archived'));
  expect(resolved.startsWith(archiveDir + path.sep)).toBe(true);
});

test('archivedTwinExists returns true when the twin lives in an EPIC\'s prds-archived dir', async () => {
  // Regression cover for job 865: every new PRD is Epic-scoped, and
  // archiveCompletedPrd archives into the Epic's own sibling prds-archived/,
  // not the retired flat one. A queue row whose PRD moved there must still
  // be recognized as stale.
  const cwd = makeFixtureCwd();
  const slug = '865-paste-image-in-chat-does-not-work';
  const epicArchiveDir = path.join(
    cwd, 'session-manager-operations', 'scheduler', 'epics', 'psess-fixture-1', 'prds-archived',
  );
  fs.mkdirSync(epicArchiveDir, { recursive: true });
  fs.writeFileSync(path.join(epicArchiveDir, `${slug}.md`), '# Goal\n\nshipped\n', 'utf8');

  await expect(archivedTwinExists({ slug, cwd })).resolves.toBe(true);
});

test('archivedTwinExists still returns true for a flat-layout twin', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-flat-layout-twin';
  const archivedDir = path.join(prdDirForCwd(cwd), '..', 'prds-archived');
  fs.mkdirSync(archivedDir, { recursive: true });
  fs.writeFileSync(path.join(archivedDir, `${slug}.md`), '# Goal\n\nshipped\n', 'utf8');

  await expect(archivedTwinExists({ slug, cwd })).resolves.toBe(true);
});

test('archivedTwinExists returns false when no twin exists in any layout', async () => {
  const cwd = makeFixtureCwd();
  const slug = 'test-no-twin-anywhere';
  fs.mkdirSync(prdDirForCwd(cwd), { recursive: true });

  await expect(archivedTwinExists({ slug, cwd })).resolves.toBe(false);
});

test('listArchivedPrdDirs returns the flat dir plus every existing epic archive dir', () => {
  const cwd = makeFixtureCwd();
  const epicArchiveDir1 = path.join(
    cwd, 'session-manager-operations', 'scheduler', 'epics', 'psess-a', 'prds-archived',
  );
  const epicArchiveDir2 = path.join(
    cwd, 'session-manager-operations', 'scheduler', 'epics', 'psess-b', 'prds-archived',
  );
  // psess-c has no prds-archived dir yet — should be excluded.
  fs.mkdirSync(path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'psess-c', 'prds'), { recursive: true });
  fs.mkdirSync(epicArchiveDir1, { recursive: true });
  fs.mkdirSync(epicArchiveDir2, { recursive: true });

  const dirs = listArchivedPrdDirs(cwd);
  const flatDir = path.join(prdDirForCwd(cwd), '..', 'prds-archived');
  expect(dirs).toContain(flatDir);
  expect(dirs).toContain(epicArchiveDir1);
  expect(dirs).toContain(epicArchiveDir2);
  expect(dirs).not.toContain(path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'psess-c', 'prds-archived'));
});

test('listArchivedPrdDirs never throws for a cwd with no session-manager-operations/ at all', () => {
  const cwd = makeFixtureCwd();
  expect(() => listArchivedPrdDirs(cwd)).not.toThrow();
  const dirs = listArchivedPrdDirs(cwd);
  expect(dirs.length).toBe(1);
});
