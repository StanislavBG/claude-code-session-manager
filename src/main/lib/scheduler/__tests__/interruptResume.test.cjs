/**
 * interruptResume.test.cjs — human.interrupt on a running scheduler job keeps
 * its CLI session id and leaves the row resumable (status pending, phase
 * idle, held off the picker); continueJob resumes the SAME session via
 * `--resume <id>`.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs (paths are baked at require).
 *
 * Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/interruptResume.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let phaseOfJob;
let readEpicEvents;

const EPIC = 'epic-interrupt-fixture';
const SESSION = '11111111-2222-4333-8444-555555555555';
const SLUG = '10-target';

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'interrupt-resume-test-'));
  process.env.HOME = tmpHome;
  scheduler = require('../../../scheduler.cjs');
  ({ phaseOfJob } = require('../../phaseProjection.cjs'));
  ({ readEpicEvents } = require('../../epic/epicEventLog.cjs'));
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
  // readQueue enumerates known project cwds from ~/.claude/projects transcripts.
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd: cwdOf() })}\n`);
  require('../../../config.cjs').addAllowedRoot(cwdOf());
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function cwdOf() {
  return path.join(tmpHome, 'proj');
}

async function rowOf(slug) {
  const queuePath = path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'state', 'queue.json');
  return JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
}

beforeEach(async () => {
  fs.mkdirSync(cwdOf(), { recursive: true });
  fs.rmSync(path.join(cwdOf(), 'session-manager-operations', 'events'), { recursive: true, force: true });
  await scheduler.writeQueue({
    jobs: [{
      slug: SLUG,
      title: SLUG,
      cwd: cwdOf(),
      epicId: EPIC,
      claudeSessionId: 'origin-epic-session',
      status: 'running',
      runId: 'run-1',
      startedAt: new Date().toISOString(),
      sessionId: SESSION,
      // No pid: nothing real to SIGTERM in a unit test.
      runtime: { runId: 'run-1', sessionId: SESSION, cwd: cwdOf() },
      dependsOn: [],
    }],
    config: {},
    paused: null,
  });
});

afterEach(() => {
  scheduler._setSpawnJobForTests(null);
});

async function waitForEvents(kind) {
  for (let i = 0; i < 40; i++) {
    const { events } = await readEpicEvents(cwdOf(), EPIC, { kinds: [kind] });
    if (events.length) return events;
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

test('interrupt keeps the session id, lands phase idle, holds the row, appends human.interrupt', async () => {
  const res = await scheduler.remote.interruptJob(SLUG, { cwd: cwdOf() });
  expect(res).toMatchObject({ ok: true, status: 'pending', phase: 'idle', sessionId: SESSION });

  const row = await rowOf(SLUG);
  expect(row.status).toBe('pending');
  expect(row.sessionId).toBe(SESSION);
  expect(row.claudeSessionId).toBe('origin-epic-session');
  expect(row.interrupted).toMatchObject({ runId: 'run-1', sessionId: SESSION });
  expect(row.runtime).toBeUndefined();
  expect(row.cancelledAt).toBeUndefined();
  expect(phaseOfJob(row)).toBe('idle');
  // Held off the picker: a fresh dispatch would mint a new session.
  expect(scheduler.computeInterruptHolds([row]).has(SLUG)).toBe(true);

  const events = await waitForEvents('human.interrupt');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'human.interrupt', slug: SLUG, sessionId: SESSION, runId: 'run-1' });
});

test('cancelJob with interrupt:true takes the interrupt path for a running job', async () => {
  const res = await scheduler.remote.cancelJob(SLUG, { cwd: cwdOf(), interrupt: true });
  expect(res).toMatchObject({ ok: true, status: 'pending', sessionId: SESSION });
  const row = await rowOf(SLUG);
  expect(row.status).toBe('pending');
  expect(row.interrupted?.sessionId).toBe(SESSION);
});

test('interrupt refuses a row that is not running', async () => {
  await scheduler.remote.interruptJob(SLUG, { cwd: cwdOf() });
  const again = await scheduler.remote.interruptJob(SLUG, { cwd: cwdOf() });
  expect(again.ok).toBe(false);
});

test('continue resumes the same session with --resume <same id>', async () => {
  await scheduler.remote.interruptJob(SLUG, { cwd: cwdOf() });
  const calls = [];
  scheduler._setSpawnJobForTests(async (job, runId, runDir, defaultCwd, resumeTarget) => {
    calls.push({ job, resumeTarget });
  });
  const res = await scheduler.remote.continueJob(SLUG, { cwd: cwdOf(), message: 'carry on' });
  expect(res).toMatchObject({ ok: true, sessionId: SESSION, resume: true });
  await new Promise((r) => setTimeout(r, 0));

  expect(calls).toHaveLength(1);
  expect(calls[0].job.slug).toBe(SLUG);
  expect(calls[0].resumeTarget).toMatchObject({ sessionId: SESSION, interrupt: true, message: 'carry on' });

  // The resume target drives executeJob's argv: --resume <same id>, never --session-id.
  const argv = scheduler.buildClaudeSpawnArgs({ model: 'sonnet', sessionId: calls[0].resumeTarget.sessionId, resume: true });
  const i = argv.indexOf('--resume');
  expect(i).toBeGreaterThan(-1);
  expect(argv[i + 1]).toBe(SESSION);
  expect(argv).not.toContain('--session-id');

  const prompt = scheduler.buildInterruptContinuePreamble(calls[0].resumeTarget);
  expect(prompt).toMatch(/CONTINUE AFTER INTERRUPT/);
  expect(prompt).toMatch(/carry on/);

  const row = await rowOf(SLUG);
  expect(row.interrupted).toBeUndefined();
  expect(scheduler.computeInterruptHolds([row]).has(SLUG)).toBe(false);
});

test('continue refuses a row that was never interrupted', async () => {
  const res = await scheduler.remote.continueJob(SLUG, { cwd: cwdOf() });
  expect(res.ok).toBe(false);
});
