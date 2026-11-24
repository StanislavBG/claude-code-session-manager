/**
 * scheduler-investigation-hold.test.cjs — the auto-fix investigation probe is
 * an automatic `claude -p` like any tick dispatch, so it obeys the same
 * auto-dispatch hold (autoDispatchHold.evaluateAutoDispatchHold) tickBody
 * uses. spawnInvestigation is reached from spawnJob's failure path and the
 * periodic auto-fix pass, never through tickBody, so it checks the hold itself.
 *
 * While held: nothing is spawned, the row stays eligible (no autoFixAttempted,
 * no autoFixRetries) and one 'investigation_held' audit event is appended.
 * Once the hold clears, the periodic pass (reverifyNeedsReview →
 * selectAutoFixTargets) launches it — recorded via _setSpawnInvestigationForTests.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-investigation-hold.test.cjs
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
let runtimeState;
let originalFetchUsage;
let launched = [];
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

// One project with one needs_review row selectAutoFixTargets would pick
// (needs_review, runId, no fix-plan sibling). Wipes earlier projects so the
// machine-wide passes only see this one.
function setupRow(extra = {}) {
  seq += 1;
  fs.rmSync(path.join(tmpHome, 'Projects'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true, force: true });
  const name = `inv-hold-${seq}`;
  const cwd = path.join(tmpHome, 'Projects', name);
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${name}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  const slug = `9401-inv-hold-${process.pid}-${seq}`;
  const runId = `run-inv-hold-${seq}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const job = {
    slug, title: slug, status: 'needs_review', cwd, runId, dependsOn: [],
    verifierVerdict: 'investigation_hold_fixture',
    createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    ...extra,
  };
  const queueFile = path.join(stateDir, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({
    config: { firePolicy: 'when-available', utilizationThreshold: 90 },
    jobs: [job],
  }));
  queueStore.bustCwdCache();
  return { slug, job, runDir, queueFile };
}

function rowOf(t) {
  return JSON.parse(fs.readFileSync(t.queueFile, 'utf8')).jobs.find((j) => j.slug === t.slug);
}

function heldEvents(slug) {
  const p = auditLog.auditLogPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.kind === 'investigation_held' && e.slug === slug);
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inv-hold-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_CLAUDE_VERSION = '2.0.0-test';
  delete process.env.SM_AUTOFIX_DISABLE;
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
  runtimeState = require('../lib/scheduler/schedulerRuntimeState.cjs');
  originalFetchUsage = billing.fetchUsage;
  scheduler._setSpawnInvestigationForTests(async (job) => { launched.push(job.slug); return { deferred: false }; });
});

beforeEach(() => { launched = []; });

afterAll(() => {
  scheduler._setSpawnInvestigationForTests(null);
  billing.fetchUsage = originalFetchUsage;
  if (originalMeminfo === undefined) delete process.env.SM_MEMINFO_PATH;
  else process.env.SM_MEMINFO_PATH = originalMeminfo;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_CLAUDE_VERSION;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('spawnInvestigation under the hold spawns nothing, leaves the row eligible, audits investigation_held', async () => {
  await reading(96);
  const t = setupRow();
  const r = await scheduler.spawnInvestigation(rowOf(t), t.runDir);
  expect(r).toMatchObject({ deferred: true, held: true });
  // Nothing launched: no probe log, no reserved investigation slot.
  expect(fs.existsSync(path.join(t.runDir, `${t.slug}.investigation.log`))).toBe(false);
  expect(runtimeState.investigationCount()).toBe(0);
  const row = rowOf(t);
  expect(row.autoFixAttempted).toBeUndefined();
  expect(row.autoFixRetries).toBeUndefined();
  expect(row.status).toBe('needs_review');
  const events = heldEvents(t.slug);
  expect(events).toHaveLength(1);
  expect(events[0].reason).toBe('utilization-held');
});

test('the periodic auto-fix pass defers while held, then launches once the hold clears', async () => {
  await reading(96);
  const t = setupRow();
  await scheduler.reverifyNeedsReview();
  expect(launched).toEqual([]);
  let row = rowOf(t);
  expect(row.autoFixAttempted).toBeUndefined();
  expect(row.autoFixRetries).toBeUndefined();
  expect(heldEvents(t.slug)).toHaveLength(1);

  await reading(40);
  await scheduler.reverifyNeedsReview();
  expect(launched).toEqual([t.slug]);
  row = rowOf(t);
  expect(row.autoFixAttempted).toBe(true);
  expect(heldEvents(t.slug)).toHaveLength(1);
});
