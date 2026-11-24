/**
 * scheduler-resume-recovery-hold.test.cjs — resume recovery is an automatic
 * `claude -p` (`--resume`) reached from spawnJob's park path and the periodic
 * reverifyNeedsReview pass, never through tickBody — so spawnResumeRecovery
 * checks the same auto-dispatch hold (autoDispatchHold.evaluateAutoDispatchHold)
 * itself.
 *
 * While held: nothing is spawned, the row stays needs_review with
 * resumeRecoveryAttempted unset, and one 'resume_recovery_held' audit event is
 * appended. Under the threshold: the call reaches spawnJob, and the periodic
 * pass (selectResumeRecoveryBatch) resumes the deferred row. Spawns are
 * recorded via _setSpawnJobForTests.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-resume-recovery-hold.test.cjs
 */
'use strict';

import { test, expect, beforeAll, beforeEach, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let tmpHome;
let originalHome;
let originalMeminfo;
let scheduler;
let billing;
let queueStore;
let auditLog;
let originalFetchUsage;
let spawned = [];
let seq = 0;

function iso(offsetMs) { return new Date(Date.now() + offsetMs).toISOString(); }

function weekly(pct) {
  return {
    kind: 'ok',
    data: {
      usage: {
        five_hour: { utilization: 10, resets_at: iso(2 * HOUR) },
        limits: [
          { kind: 'session', percent: 10, resets_at: iso(2 * HOUR), scope: null },
          { kind: 'weekly_all', percent: pct, resets_at: iso(3 * DAY), scope: null },
        ],
      },
    },
  };
}

async function reading(pct) {
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => weekly(pct);
  await scheduler.refreshNextReset();
}

// One project with one needs_review row selectResumeRecoveryTarget accepts.
// Wipes earlier projects so the machine-wide passes only see this one.
function setupRow() {
  seq += 1;
  fs.rmSync(path.join(tmpHome, 'Projects'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true, force: true });
  const name = `resume-hold-${seq}`;
  const cwd = path.join(tmpHome, 'Projects', name);
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${name}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  const slug = `9501-resume-hold-${process.pid}-${seq}`;
  const job = {
    slug, title: slug, status: 'needs_review', cwd, runId: `run-resume-hold-${seq}`, dependsOn: [],
    verifierVerdict: 'uncommitted_changes',
    sessionId: `sess-resume-hold-${seq}`,
    uncommittedPaths: ['src/foo.js'],
    createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
  const queueFile = path.join(stateDir, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({
    config: { firePolicy: 'when-available', utilizationThreshold: 90 },
    jobs: [job],
  }));
  queueStore.bustCwdCache();
  return { slug, job, queueFile };
}

function rowOf(t) {
  return JSON.parse(fs.readFileSync(t.queueFile, 'utf8')).jobs.find((j) => j.slug === t.slug);
}

function target(job) {
  return { slug: job.slug, sessionId: job.sessionId, dirtyPaths: job.uncommittedPaths, salvagePatch: null };
}

function heldEvents(slug) {
  const p = auditLog.auditLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.kind === 'resume_recovery_held' && e.slug === slug);
}

async function waitFor(pred, ms = 5000) {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-resume-hold-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  process.env.SM_CLAUDE_VERSION = '2.0.0-test';
  delete process.env.SM_RESUME_RECOVERY_DISABLE;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  originalMeminfo = process.env.SM_MEMINFO_PATH;
  const ample = path.join(tmpHome, 'meminfo-64gb');
  fs.writeFileSync(ample, 'MemAvailable:    67108864 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
  process.env.SM_MEMINFO_PATH = ample;
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  auditLog = require('../lib/telemetry/auditLog.cjs');
  originalFetchUsage = billing.fetchUsage;
  scheduler._setSpawnJobForTests(async (job, _runId, _runDir, _cwd, resumeTarget) => {
    spawned.push({ slug: job.slug, resume: resumeTarget?.sessionId ?? null });
  });
});

beforeEach(() => { spawned = []; });

afterAll(() => {
  scheduler._setSpawnJobForTests(null);
  billing.fetchUsage = originalFetchUsage;
  if (originalMeminfo === undefined) delete process.env.SM_MEMINFO_PATH;
  else process.env.SM_MEMINFO_PATH = originalMeminfo;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_VERSION;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('spawnResumeRecovery at 96% ≥ 90% spawns nothing, leaves the row needs_review, audits resume_recovery_held', async () => {
  await reading(96);
  const t = setupRow();
  await scheduler.spawnResumeRecovery(rowOf(t), target(t.job));
  expect(spawned).toEqual([]);
  const row = rowOf(t);
  expect(row.status).toBe('needs_review');
  expect(row.resumeRecoveryAttempted).toBeUndefined();
  const events = heldEvents(t.slug);
  expect(events).toHaveLength(1);
  expect(events[0].reason).toBe('utilization-held');
});

test('spawnResumeRecovery under the threshold reaches spawnJob with the resume target', async () => {
  await reading(40);
  const t = setupRow();
  await scheduler.spawnResumeRecovery(rowOf(t), target(t.job));
  expect(spawned).toEqual([{ slug: t.slug, resume: t.job.sessionId }]);
  expect(heldEvents(t.slug)).toHaveLength(0);
});

test('the periodic pass defers while held, then resumes the job once the hold clears', async () => {
  await reading(96);
  const t = setupRow();
  await scheduler.reverifyNeedsReview();
  await waitFor(() => heldEvents(t.slug).length > 0);
  expect(spawned).toEqual([]);
  expect(rowOf(t).resumeRecoveryAttempted).toBeUndefined();
  expect(heldEvents(t.slug)).toHaveLength(1);

  await reading(40);
  await scheduler.reverifyNeedsReview();
  await waitFor(() => spawned.length > 0);
  expect(spawned).toEqual([{ slug: t.slug, resume: t.job.sessionId }]);
  expect(heldEvents(t.slug)).toHaveLength(1);
});

test('one resume_recovery_held line per row per hold; a cleared then new hold audits once more', async () => {
  await reading(96);
  const t = setupRow();
  await scheduler.spawnResumeRecovery(rowOf(t), target(t.job));
  await scheduler.spawnResumeRecovery(rowOf(t), target(t.job));
  expect(spawned).toEqual([]);
  expect(heldEvents(t.slug)).toHaveLength(1);

  // Hold clears: the row is launched and its key removed.
  await reading(40);
  await scheduler.spawnResumeRecovery(rowOf(t), target(t.job));
  expect(spawned).toEqual([{ slug: t.slug, resume: t.job.sessionId }]);
  expect(heldEvents(t.slug)).toHaveLength(1);

  // A new hold audits exactly once more.
  await reading(97);
  await scheduler.spawnResumeRecovery(rowOf(t), target(t.job));
  await scheduler.spawnResumeRecovery(rowOf(t), target(t.job));
  expect(heldEvents(t.slug)).toHaveLength(2);
});
