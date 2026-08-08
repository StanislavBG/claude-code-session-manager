/**
 * scheduler-reconcile-invalid-repair.test.cjs — end-to-end reproduction of
 * the 2026-08-07 1021/1022 incident: a queue.json row with `"status":
 * "queued"` (a value outside ScheduleJobStatus) sat unpicked for 4+ hours.
 *
 * queueStore.shapeJobs (scheduleJobSchema.cjs, landed by a prior PRD)
 * already quarantines such a row into `invalidJobs` on read rather than
 * passing it through — but reconcile() itself was still add-only (`if
 * (seen.has(slug)) continue`), so a quarantined row was never repaired, only
 * silently absent from state.jobs with no log of what its bad status had
 * been.
 *
 * This test exercises the real quarantine path (queueStore.shapeJobs on the
 * raw incident JSON) against a real on-disk PRD, runs the real reconcile(),
 * and asserts: computeStallSummary flags the PRE-repair state as stalled,
 * reconcile() repairs the row to 'pending', logs the repair at warn level,
 * and audits it.
 *
 * HOME-isolated (mirrors scheduler-prd-missing-skip.test.cjs): stub HOME to
 * a mkdtemp dir before requiring scheduler.cjs/queueStore.cjs, and register
 * the fixture project as "active" via a fake ~/.claude/projects transcript —
 * reconcile's PRD/history discovery (prdLocations.cjs, queueHistory.cjs)
 * only scans cwds it can find that way.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reconcile-invalid-repair.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let queueHistory;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reconcile-repair-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
  queueHistory = require('../lib/queueHistory.cjs');

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
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
  const prdsDir = path.join(opsRoot, 'scheduler', 'prds');
  const stateDir = path.join(opsRoot, 'scheduler', 'state');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { cwd, prdsDir, stateDir };
}

test('reconcile() repairs a queue row with an invalid status back to pending, logs, and audits it', async () => {
  const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-reconcile-repair-proj-');
  try {
    // Real on-disk PRD (its file location is the reconcile source of truth).
    fs.writeFileSync(
      path.join(prdsDir, '1021-fix-the-thing.md'),
      '---\ntitle: Fix the thing\ncwd: ' + cwd + '\nestimateMinutes: 15\n---\n\n# Goal\nFix it.\n',
      'utf8',
    );

    // The exact incident shape: a row whose status is 'queued', outside
    // ScheduleJobStatus entirely.
    const badRow = {
      slug: '1021-fix-the-thing',
      title: 'Fix the thing',
      cwd,
      status: 'queued',
      runId: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
    };
    const queuePath = path.join(stateDir, 'queue.json');
    fs.writeFileSync(queuePath, JSON.stringify({ jobs: [badRow] }, null, 2), 'utf8');

    // Exercise the REAL quarantine gate (same one queueStore.readMerged runs
    // at boot/every IPC read) rather than hand-building invalidJobs.
    const { jobs, invalid } = queueStore.shapeJobs(fs.readFileSync(queuePath, 'utf8'), queuePath);
    expect(jobs.length).toBe(0); // the bad row never reaches state.jobs
    expect(invalid.length).toBe(1);
    expect(invalid[0].slug).toBe(badRow.slug);
    expect(invalid[0].row.status).toBe('queued');

    const state = { jobs, invalidJobs: invalid, paused: null };

    // Stall detector must flag the PRE-repair state: the queue holds a
    // (quarantined) job but nothing is running or pending and it isn't
    // paused — this is exactly the condition that was silent for 4+ hours.
    const preRepairStall = scheduler.computeStallSummary(state);
    expect(preRepairStall.stalled).toBe(true);
    expect(preRepairStall.total).toBe(1);
    expect(preRepairStall.running).toBe(0);
    expect(preRepairStall.pending).toBe(0);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // scheduler.cjs destructures `appendAuditEvent` out of auditLog.cjs at
    // require time, so spying on the module's export property after the
    // fact wouldn't intercept scheduler.cjs's already-bound reference —
    // assert against the real (tmpHome-isolated) audit log file instead.
    const { AUDIT_LOG_PATH } = require('../lib/auditLog.cjs');
    expect(AUDIT_LOG_PATH.startsWith(tmpHome)).toBe(true);

    queueStore.bustCwdCache();
    await scheduler.reconcile(state);

    const repaired = state.jobs.find((j) => j.slug === badRow.slug);
    expect(repaired).toBeDefined();
    expect(repaired.status).toBe('pending');

    const warnedRepair = warnSpy.mock.calls.some((args) =>
      String(args[0]).includes('repaired invalid queue row') && String(args[0]).includes(badRow.slug),
    );
    expect(warnedRepair).toBe(true);

    const auditLines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const auditedRepair = auditLines.some(
      (rec) => rec.kind === 'scheduler_row_repaired' && rec.slug === badRow.slug && rec.oldStatus === 'queued',
    );
    expect(auditedRepair).toBe(true);

    // Post-repair, the same condition must no longer read as stalled.
    const postRepairStall = scheduler.computeStallSummary(state);
    expect(postRepairStall.stalled).toBe(false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('reconcile() does not resurrect an invalid row whose slug already has a terminal history record', async () => {
  const { cwd, prdsDir, stateDir } = makeFixtureProject('sm-reconcile-repair-done-');
  try {
    fs.writeFileSync(
      path.join(prdsDir, '1022-already-done.md'),
      '---\ntitle: Already done\ncwd: ' + cwd + '\nestimateMinutes: 15\n---\n\n# Goal\nDone.\n',
      'utf8',
    );

    const badRow = {
      slug: '1022-already-done',
      title: 'Already done',
      cwd,
      status: 'queued',
      runId: 'run-xyz',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      error: null,
    };
    const queuePath = path.join(stateDir, 'queue.json');
    fs.writeFileSync(queuePath, JSON.stringify({ jobs: [badRow] }, null, 2), 'utf8');

    const { jobs, invalid } = queueStore.shapeJobs(fs.readFileSync(queuePath, 'utf8'), queuePath);
    expect(invalid.length).toBe(1);

    const state = { jobs, invalidJobs: invalid, paused: null };

    // A terminal record already exists for this slug — reconcile must never
    // repair the corrupted row back into a runnable 'pending' state on top
    // of already-shipped work.
    fs.writeFileSync(
      path.join(stateDir, 'history.jsonl'),
      JSON.stringify({ slug: badRow.slug, status: 'completed', finishedAt: new Date().toISOString(), runId: 'run-xyz' }) + '\n',
      'utf8',
    );

    queueStore.bustCwdCache();
    await scheduler.reconcile(state);

    expect(state.jobs.find((j) => j.slug === badRow.slug)).toBeUndefined();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
