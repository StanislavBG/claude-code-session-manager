/**
 * scheduler-agent-pause.test.cjs — pauses arriving over the admin route are a
 * distinct, attributed, self-expiring 'agent' pause; manual outranks agent;
 * pause/resume are audited; boot clears manual/agent pauses.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-agent-pause.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-agent-pause-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await scheduler.clearPause('manual');
});

test('remote.pause persists an attributed agent pause with a 30-minute resumeAt', async () => {
  const before = Date.now();
  await scheduler.remote.pause({ originClaudeSessionId: 'sess-1', cwd: '/x/family-frame', reason: 'divergence' });
  const { paused } = await queueStore.readMerged();
  expect(paused.reason).toBe('agent');
  expect(paused.by).toEqual({ originClaudeSessionId: 'sess-1', cwd: '/x/family-frame', reason: 'divergence' });
  const ttl = new Date(paused.resumeAt).getTime() - new Date(paused.since).getTime();
  expect(Math.abs(ttl - 30 * 60_000)).toBeLessThan(2000);
  expect(new Date(paused.since).getTime()).toBeGreaterThanOrEqual(before - 1000);
});

test('agent pause is not suppressed by the manual-override cooldown', async () => {
  await scheduler.clearPause('manual'); // starts cooldown
  await scheduler.setPaused('agent', null, { by: { originClaudeSessionId: null, cwd: null, reason: null } });
  expect((await queueStore.readMerged()).paused.reason).toBe('agent');
});

test('manual outranks agent: agent is a no-op during manual, manual replaces agent', async () => {
  await scheduler.setPaused('manual', null);
  await scheduler.setPaused('agent', null, { by: { reason: 'x' } });
  expect((await queueStore.readMerged()).paused.reason).toBe('manual');
  await scheduler.clearPause('manual');
  await scheduler.setPaused('agent', null);
  await scheduler.setPaused('manual', null);
  const { paused } = await queueStore.readMerged();
  expect(paused.reason).toBe('manual');
  expect(paused.resumeAt).toBeNull();
});

test('pause and resume are audited; resume only when a pause was cleared', async () => {
  const audit = require('../lib/auditLog.cjs');
  const spy = [];
  const orig = audit.appendAuditEvent;
  // scheduler captured appendAuditEvent by destructuring, so assert via the log file instead
  void spy; void orig;
  const dump = () => {
    const out = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/audit/i.test(p)) out.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(tmpHome);
    return out.join('\n');
  };
  await scheduler.clearPause('boot'); // nothing paused -> no resume event
  const base = (dump().match(/scheduler_resume/g) || []).length;
  await scheduler.remote.pause({ reason: 'audit-me' });
  await scheduler.clearPause('boot');
  const text = dump();
  expect(text).toContain('scheduler_pause');
  expect(text).toContain('audit-me');
  expect((text.match(/scheduler_resume/g) || []).length).toBe(base + 1);
  expect(text).toContain('"clearedReason":"agent"');
});

test('boot clears persisted manual and agent pauses', async () => {
  await scheduler.setPaused('manual', null);
  await scheduler.clearPause('boot');
  expect((await queueStore.readMerged()).paused).toBeNull();
  await scheduler.remote.pause({});
  await scheduler.clearPause('boot');
  expect((await queueStore.readMerged()).paused).toBeNull();
});
