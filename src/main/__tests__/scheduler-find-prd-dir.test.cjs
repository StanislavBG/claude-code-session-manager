/**
 * scheduler-find-prd-dir.test.cjs — unit test for findPrdDir's legacy-dir
 * fallback (PRD 812 split-brain fix): a PRD slug that exists only in the
 * legacy global `~/.claude/session-manager/scheduled-plans/prds/` dir (not
 * yet migrated into any project's own
 * `<cwd>/session-manager-operations/scheduler/prds/`) must still resolve,
 * since findPrdDir's candidatePrdsDirs() searches the legacy dir first.
 *
 * HOME-isolated (PRD 812 incident fix): scheduler.cjs derives PRDS_DIR from
 * os.homedir() at module load. This test used to write straight into the
 * REAL `~/.claude/session-manager/scheduled-plans/prds/` — the live
 * scheduler's `reconcile()` scans that dir every 60s and enqueued the
 * fixture as a phantom job (job 812-test-legacy-only-1975929-233060) before
 * this test's own cleanup ran. Now HOME is stubbed to a mkdtemp dir BEFORE
 * scheduler.cjs is first required, so PRDS_DIR resolves under the temp dir
 * and nothing here can reach the real scheduler root. The
 * `PRDS_DIR.startsWith(tmpHome)` guard is the regression test for that
 * incident: if module-load ordering ever changes so the real homedir gets
 * snapshotted first, this throws loudly instead of silently poisoning the
 * live queue again.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-find-prd-dir.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let findPrdDir;
let PRDS_DIR;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-find-prd-dir-'));
  process.env.HOME = tmpHome;

  // Load AFTER HOME is stubbed — scheduler.cjs snapshots os.homedir() into
  // PRDS_DIR at module load, not lazily.
  ({ findPrdDir, PRDS_DIR } = require('../scheduler.cjs'));

  // Hard guard: never let this test write into the real scheduler root.
  if (!PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('findPrdDir resolves a slug that exists only in the legacy global PRDs dir', async () => {
  const slug = `812-test-legacy-only-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const legacyPath = path.join(PRDS_DIR, `${slug}.md`);
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  fs.writeFileSync(legacyPath, '---\ntitle: legacy fixture\n---\n\n# Goal\n\ntest\n', 'utf8');

  try {
    const dir = await findPrdDir(slug);
    expect(dir).toBe(PRDS_DIR);
  } finally {
    fs.rmSync(legacyPath, { force: true });
  }
});

test('findPrdDir returns null for a slug that exists nowhere', async () => {
  const slug = `812-test-nonexistent-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const dir = await findPrdDir(slug);
  expect(dir).toBe(null);
});
