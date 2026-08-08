/**
 * reconcileFlatPrdSweep.test.cjs — end-to-end proof that `reconcile()` itself
 * (not just `consolidateAllFlatPrds()` in isolation) never turns a
 * hand-written flat-dir PRD into a queue job, regardless of which of
 * reconcile's several callers (tickQueue's poll, job completion, the
 * schedule:state/schedule:rescan IPC handlers, rescheduleTimer) triggered
 * the pass.
 *
 * A code-review pass on this PRD flagged that gating only `tickQueue()` left
 * every OTHER caller of `reconcile()` free to still turn a freshly
 * hand-written flat-dir PRD into a `pending` job — the fix moved the sweep
 * inside `reconcile()` itself instead. This test exercises the real
 * `reconcile()` (not a stand-in) against a real on-disk flat-dir PRD with no
 * pre-existing queue row (exactly the state of a file dropped there moments
 * ago) and asserts it never appears in `state.jobs` afterward.
 *
 * HOME-isolated (mirrors scheduler-reconcile-invalid-repair.test.cjs): stub
 * HOME to a mkdtemp dir before requiring scheduler.cjs, and register the
 * fixture project as "active" via a fake ~/.claude/projects transcript —
 * reconcile's PRD discovery (prdLocations.cjs) only scans cwds it can find
 * that way.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/reconcileFlatPrdSweep.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-flatsweep-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerActiveProject(cwd);
  const opsRoot = path.join(cwd, 'session-manager-operations');
  const flatPrdsDir = path.join(opsRoot, 'scheduler', 'prds');
  const stateDir = path.join(opsRoot, 'scheduler', 'state');
  fs.mkdirSync(flatPrdsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { cwd, flatPrdsDir, stateDir, archiveDir: path.join(opsRoot, 'scheduler', 'prds-archived') };
}

test('reconcile() never turns a hand-written flat-dir PRD into a job, no matter which caller triggers it', async () => {
  const { cwd, flatPrdsDir, archiveDir } = makeFixtureProject('sm-reconcile-flatsweep-proj-');
  const filename = '1500-hand-written-bypass.md';
  fs.writeFileSync(
    path.join(flatPrdsDir, filename),
    `---\ntitle: Hand-written bypass\ncwd: ${cwd}\nestimateMinutes: 10\n---\n\n# Goal\n\nSomething.\n`,
    'utf8',
  );
  // No queue.json at all — the exact state of a PRD dropped on disk moments
  // ago, before any prior reconcile() pass has scanned it into a job.

  const state = { jobs: [], invalidJobs: [], paused: null };
  await scheduler.reconcile(state);

  const found = state.jobs.find((j) => j.slug === '1500-hand-written-bypass');
  expect(found).toBeUndefined();
  expect(fs.existsSync(path.join(flatPrdsDir, filename))).toBe(false);
  expect(fs.existsSync(path.join(archiveDir, filename))).toBe(true);
});

test('reconcile() still onboards a PRD written to the canonical Epic-scoped dir (the sweep only touches the flat dir)', async () => {
  const { cwd } = makeFixtureProject('sm-reconcile-flatsweep-epic-proj-');
  const epicId = 'epic-abc';
  const epicPrdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
  fs.mkdirSync(epicPrdsDir, { recursive: true });
  fs.writeFileSync(
    path.join(epicPrdsDir, '1501-canonical.md'),
    `---\ntitle: Canonical\ncwd: ${cwd}\nestimateMinutes: 10\nsourcePromptId: ${epicId}\ncreatedVia: scheduler-api\nissuedAt: 2026-08-07T00:00:00.000Z\n---\n\n# Goal\n\nSomething.\n`,
    'utf8',
  );

  const state = { jobs: [], invalidJobs: [], paused: null };
  await scheduler.reconcile(state);

  const found = state.jobs.find((j) => j.slug === '1501-canonical');
  expect(found).toBeDefined();
  expect(found.status).toBe('pending');
});
