/**
 * scheduler-tool-confirmation-hold.test.cjs — an approved tool-risk
 * confirmation answer resumes its job (`claude -p --resume`) only when the
 * tick that applies it would dispatch: under the auto-dispatch hold an
 * automatic tick leaves the record pending, a later tick applies it once the
 * hold clears, and a human tick bypasses the hold. A denial starts no process,
 * so it is applied even while held.
 *
 * Launches go to an injected spawn recorder (_setSpawnJobForTests).
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-tool-confirmation-hold.test.cjs
 */
'use strict';

import { test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PRD_BODY = '---\ntitle: Confirm PRD\ncreatedVia: scheduler-api\n---\n\nConfirm PRD.\n';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let tmpHome;
let originalHome;
let originalMeminfo;
let scheduler;
let billing;
let queueStore;
let toolClearance;
let needsYouStore;
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

async function goodReading(usage) {
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => usage;
  await scheduler.refreshNextReset();
}

/** One needs_review row parked on a confirm request, its pending record, and the owner's answer. */
async function parkedRequest(answer) {
  seq += 1;
  const name = `confirm-proj-${seq}`;
  const cwd = path.join(tmpHome, 'Projects', name);
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'fixture-epic', 'prds');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(prdsDir, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${name}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  const slug = `9401-confirm-${process.pid}-${seq}`;
  const sessionId = crypto.randomUUID();
  const tool = `mcp__fixture__risky_${seq}`;
  const argsDigest = crypto.createHash('sha256').update(`args-${seq}`).digest('hex');
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  const queueFile = path.join(stateDir, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({
    jobs: [{ slug, title: slug, status: 'needs_review', cwd, sessionId, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
  queueStore.bustCwdCache();
  expect(toolClearance.recordPendingConfirmation({ tool, argsDigest, jobSlug: slug, sessionId, cwd }, { now: Date.now() - 60_000 })).toBe(true);
  await needsYouStore.postConfirmationRequest({ tool, argsDigest, jobSlug: slug });
  const answered = await needsYouStore.answerNeedsYou({ app: needsYouStore.CONFIRM_APP, id: needsYouStore.confirmationItemId(tool, argsDigest), answer });
  expect(answered).toBeTruthy();
  return { slug, sessionId, tool, argsDigest, queueFile, key: toolClearance.listPendingConfirmations().find((r) => r.tool === tool).key };
}

function isPending(req) {
  return toolClearance.listPendingConfirmations().some((r) => r.key === req.key && r.requests.some((x) => x.jobSlug === req.slug));
}

function auditEvents(kind, slug) {
  let text = '';
  try { text = fs.readFileSync(auditLog.auditLogPath(), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.kind === kind && e.slug === slug);
}

function spawnsOf(slug) { return spawned.filter((s) => s.slug === slug); }

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-confirm-hold-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  process.env.SM_CLAUDE_VERSION = '2.0.0-test';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  originalMeminfo = process.env.SM_MEMINFO_PATH;
  const ample = path.join(tmpHome, 'meminfo-64gb');
  fs.writeFileSync(ample, 'MemAvailable:    67108864 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
  process.env.SM_MEMINFO_PATH = ample;
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  toolClearance = require('../lib/scheduler/toolClearance.cjs');
  needsYouStore = require('../lib/feedback-remote/needsYouStore.cjs');
  auditLog = require('../lib/telemetry/auditLog.cjs');
  originalFetchUsage = billing.fetchUsage;
  scheduler._setSpawnJobForTests(async (job, _runId, _runDir, _cwd, resumeTarget) => {
    spawned.push({ slug: job.slug, resumeTarget });
  });
});

beforeEach(async () => {
  spawned = [];
  await scheduler._mutateForTests((s) => { s.config = { ...(s.config || {}), firePolicy: 'when-available', utilizationThreshold: 90 }; });
});

afterEach(() => {
  billing.fetchUsage = originalFetchUsage;
});

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

test('(a+b) an approved answer waits under the 96% hold, then resumes the same session once it clears', async () => {
  await goodReading(weekly(96));
  const req = await parkedRequest('Approve');

  const r1 = await scheduler.tickQueue();
  expect(r1).toMatchObject({ fired: false, reason: 'utilization-held' });
  expect(spawnsOf(req.slug)).toEqual([]);
  expect(isPending(req)).toBe(true);
  await scheduler.tickQueue();
  expect(spawnsOf(req.slug)).toEqual([]);
  expect(isPending(req)).toBe(true);
  // One audit event per record per hold, not one per tick.
  expect(auditEvents('tool_confirmation_resume_held', req.slug)).toHaveLength(1);
  expect(auditEvents('tool_confirmation_resume_held', req.slug)[0].reason).toBe('utilization-held');
  expect(auditEvents('tool_confirmation_answered', req.slug)).toHaveLength(0);

  await goodReading(weekly(40));
  await scheduler.tickQueue();
  const hits = spawnsOf(req.slug);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].resumeTarget.sessionId).toBe(req.sessionId);
  expect(hits[0].resumeTarget.confirmation).toMatchObject({ tool: req.tool, argsDigest: req.argsDigest });
});

test('(c) a human tick under the 96% hold applies the approval', async () => {
  await goodReading(weekly(96));
  const req = await parkedRequest('Approve');
  await scheduler.tickQueue({ human: true });
  const hits = spawnsOf(req.slug);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].resumeTarget.sessionId).toBe(req.sessionId);
  expect(auditEvents('tool_confirmation_resume_held', req.slug)).toHaveLength(0);
});

test('(d) a denied answer under the hold still parks the row needs_review and spawns nothing', async () => {
  await goodReading(weekly(96));
  const req = await parkedRequest('Deny');
  const r = await scheduler.tickQueue();
  expect(r.reason).toBe('utilization-held');
  expect(spawnsOf(req.slug)).toEqual([]);
  expect(isPending(req)).toBe(false);
  const row = JSON.parse(fs.readFileSync(req.queueFile, 'utf8')).jobs.find((j) => j.slug === req.slug);
  expect(row.status).toBe('needs_review');
  expect(row.confirmationDenied).toMatchObject({ tool: req.tool, argsDigest: req.argsDigest });
  expect(auditEvents('tool_confirmation_resume_held', req.slug)).toHaveLength(0);
});
