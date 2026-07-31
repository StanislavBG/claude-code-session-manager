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
