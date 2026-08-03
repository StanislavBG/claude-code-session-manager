/**
 * scheduler-verify-prd-path.test.cjs — regression test for PRD 991: the
 * verifier's `prdPath` must resolve to a REAL, existing file for an
 * Epic-scoped PRD, both live and archived.
 *
 * Before this PRD, `verifyRun`'s two call sites (the post-run verify in
 * spawnJob and reverifyNeedsReview) built `prdPath` via `prdPathForJob`,
 * which resolves to the RETIRED flat
 * `<cwd>/session-manager-operations/scheduler/prds/` dir — a dir that holds
 * only zero-byte `.reserved-NNN` stubs for every project that has migrated
 * to Epic-scoped PRDs (i.e. every project today). The verifier therefore
 * silently lost access to the PRD body (dependsOn checks, soak-floor dates,
 * deliverable-path checks, the merge-main PR-number exemption) on every
 * single run.
 *
 * This test exercises actual path resolution against a temp tree — no
 * resolver-stubbing — the same class of gap that let this bug (and PRD
 * 985's sibling notify-path bug) ship green twice.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-verify-prd-path.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let resolveVerifyPrdPath;
let archivedPrdPathForJob;
let PRDS_DIR;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-verify-prd-path-'));
  process.env.HOME = tmpHome;

  // Load AFTER HOME is stubbed — scheduler.cjs snapshots os.homedir() into
  // PRDS_DIR at module load, not lazily (see scheduler-find-prd-dir.test.cjs).
  ({ resolveVerifyPrdPath, archivedPrdPathForJob, PRDS_DIR } = require('../scheduler.cjs'));

  if (!PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }

  // allProjectCwds()/activeProjectCwds() discover project cwds by scanning
  // ~/.claude/projects/*/*.jsonl for a `cwd` field — fake one project with a
  // transcript pointing at a real on-disk cwd.
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const projDir = path.join(projectsDir, 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'session.jsonl'),
    `${JSON.stringify({ cwd: projectCwd() })}\n`,
    'utf8',
  );
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function projectCwd() {
  return path.join(tmpHome, 'fake-project-cwd');
}

test('resolveVerifyPrdPath resolves a LIVE Epic-scoped PRD to a real existing path', async () => {
  const cwd = projectCwd();
  const epicId = 'test-epic-live';
  const slug = `991-test-live-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  const prdPath = path.join(prdsDir, `${slug}.md`);
  fs.writeFileSync(prdPath, '---\ntitle: live fixture\n---\n\n# Goal\n\ntest\n', 'utf8');

  const resolved = await resolveVerifyPrdPath({ slug, cwd });
  expect(resolved).toBe(prdPath);
  expect(fs.existsSync(resolved)).toBe(true);
});

test('resolveVerifyPrdPath returns null for an ARCHIVED-only PRD; archivedPrdPathForJob fills the gap', async () => {
  const cwd = projectCwd();
  const epicId = 'test-epic-archived';
  const slug = `991-test-archived-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const epicDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId);
  const archiveDir = path.join(epicDir, 'prds-archived');
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivedPath = path.join(archiveDir, `${slug}.md`);
  fs.writeFileSync(archivedPath, '---\ntitle: archived fixture\n---\n\n# Goal\n\ntest\n', 'utf8');

  const job = { slug, cwd };
  const live = await resolveVerifyPrdPath(job);
  expect(live).toBe(null);

  const fallback = live ?? archivedPrdPathForJob(job);
  expect(fallback).toBe(archivedPath);
  expect(fs.existsSync(fallback)).toBe(true);
});

test('resolveVerifyPrdPath returns null for a slug that exists nowhere (never falls back to the retired flat dir)', async () => {
  const cwd = projectCwd();
  const slug = `991-test-nonexistent-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const resolved = await resolveVerifyPrdPath({ slug, cwd });
  expect(resolved).toBe(null);
});
