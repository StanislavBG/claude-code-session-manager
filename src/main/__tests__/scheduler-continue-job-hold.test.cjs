/**
 * scheduler-continue-job-hold.test.cjs — remote.continueJob obeys the
 * auto-dispatch hold. Its only caller is the loopback admin route, which
 * cannot prove a human pressed anything, so it never bypasses the hold:
 * while a hold is in force it refuses with the hold detail and leaves the
 * row interrupted, and the same call succeeds once the hold clears.
 *
 * A separate file from interruptResume.test.cjs: the usage reading is module
 * state, and a 96% reading left behind would refuse that file's continue test.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-continue-job-hold.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EPIC = 'epic-continue-hold-fixture';
const SESSION = '22222222-3333-4444-8555-666666666666';
const SLUG = '10-continue-hold';
const MANUAL_SLUG = '11-continue-hold-manual';

let tmpHome;
let originalHome;
let scheduler;
let billing;
let auditLog;
let originalFetchUsage;
let calls = [];

function cwdOf() { return path.join(tmpHome, 'proj'); }
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

async function rowOf(slug) {
  const queuePath = path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'state', 'queue.json');
  return JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
}

/** Every audit event of `kind` for `slug` — each test uses its own slug so counts never leak across tests. */
function auditEvents(kind, slug) {
  let text = '';
  try { text = fs.readFileSync(auditLog.auditLogPath(), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.kind === kind && e.slug === slug);
}

async function seed(config, slug = SLUG) {
  await scheduler.writeQueue({
    jobs: [{
      slug,
      title: slug,
      cwd: cwdOf(),
      epicId: EPIC,
      claudeSessionId: 'origin-epic-session',
      status: 'running',
      runId: 'run-1',
      startedAt: new Date().toISOString(),
      sessionId: SESSION,
      runtime: { runId: 'run-1', sessionId: SESSION, cwd: cwdOf() },
      dependsOn: [],
    }],
    config,
    paused: null,
  });
  const res = await scheduler.remote.interruptJob(slug, { cwd: cwdOf() });
  expect(res.ok).toBe(true);
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'continue-hold-test-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  auditLog = require('../lib/telemetry/auditLog.cjs');
  originalFetchUsage = billing.fetchUsage;
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd: cwdOf() })}\n`);
  require('../config.cjs').addAllowedRoot(cwdOf());
});

beforeEach(() => {
  fs.mkdirSync(cwdOf(), { recursive: true });
  calls = [];
  scheduler._setSpawnJobForTests(async (job, runId, runDir, defaultCwd, resumeTarget) => {
    calls.push({ slug: job.slug, resumeTarget });
  });
});

afterEach(() => {
  scheduler._setSpawnJobForTests(null);
  billing.fetchUsage = originalFetchUsage;
});

afterAll(() => {
  billing.fetchUsage = originalFetchUsage;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('a 96% reading at threshold 90 refuses continue, keeps the row interrupted; under 90 the same call resumes', async () => {
  await seed({ utilizationThreshold: 90, firePolicy: 'when-available' });
  await reading(96);

  const held = await scheduler.remote.continueJob(SLUG, { cwd: cwdOf(), source: 'admin-api' });
  expect(held.ok).toBe(false);
  expect(held.error).toMatch(/^usage hold in force: .+ - continue again once it clears$/);
  expect(held.hold).toMatchObject({ reason: 'utilization-held', percent: 96, threshold: 90 });
  expect(held.hold).toHaveProperty('window');
  expect(held.hold).toHaveProperty('resetsAt');
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toHaveLength(0);
  const heldEvents = auditEvents('job_continue_held', SLUG);
  expect(heldEvents).toHaveLength(1);
  expect(heldEvents[0]).toMatchObject({ kind: 'job_continue_held', slug: SLUG, reason: 'utilization-held' });

  const row = await rowOf(SLUG);
  expect(row.status).toBe('pending');
  expect(row.interrupted).toMatchObject({ sessionId: SESSION });
  expect(row.heldReason).toBe('interrupted by a human — waiting for continue');
  expect(scheduler.computeInterruptHolds([row]).has(SLUG)).toBe(true);

  await reading(50);
  const ok = await scheduler.remote.continueJob(SLUG, { cwd: cwdOf(), source: 'admin-api' });
  expect(ok).toMatchObject({ ok: true, sessionId: SESSION, resume: true });
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toHaveLength(1);
  expect(calls[0].resumeTarget).toMatchObject({ sessionId: SESSION, interrupt: true });
  // The resuming call appends no job_continue_held event: still only the one refusal.
  expect(auditEvents('job_continue_held', SLUG)).toHaveLength(1);
});

test("firePolicy 'manual' refuses continue the same way", async () => {
  await seed({ utilizationThreshold: 90, firePolicy: 'manual' }, MANUAL_SLUG);
  await reading(10);

  const held = await scheduler.remote.continueJob(MANUAL_SLUG, { cwd: cwdOf() });
  expect(held.ok).toBe(false);
  expect(held.hold).toMatchObject({ reason: 'manual-fire-policy' });
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toHaveLength(0);
  const heldEvents = auditEvents('job_continue_held', MANUAL_SLUG);
  expect(heldEvents).toHaveLength(1);
  expect(heldEvents[0]).toMatchObject({ kind: 'job_continue_held', slug: MANUAL_SLUG, reason: 'manual-fire-policy' });
  const row = await rowOf(MANUAL_SLUG);
  expect(row.interrupted).toMatchObject({ sessionId: SESSION });
});
