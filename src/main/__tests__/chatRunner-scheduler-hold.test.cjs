// chatRunner.enqueueExternalPrompt is the one seam that holds scheduler-started
// chat turns under the usage hold; every other origin still broadcasts at once.
// Run: timeout 120 npx vitest run src/main/__tests__/chatRunner-scheduler-hold.test.cjs
import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp;
let prevHome;
let chatRunner;
let held;
let sent;

const HOLD = {
  reason: 'utilization-held',
  window: 'seven_day',
  percent: 93,
  threshold: 90,
  resetsAt: '2026-11-30T18:00:00.000Z',
  detail: 'weekly usage 93% >= 90%',
};

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => { sent.push({ channel, payload }); },
    },
  };
}

function auditLines() {
  const p = path.join(tmp, 'audit-log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'scheduler_turn_held');
}

function externalSends() {
  return sent.filter((s) => s.channel === 'chat:external-send');
}

// Settle each broadcast request so the promise resolves quickly.
function ackAll(disposition = 'sent') {
  for (const s of externalSends()) chatRunner.settleExternalSend({ requestId: s.payload.requestId, disposition });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-sched-hold-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = tmp;
  sent = [];
  chatRunner = require('../chatRunner.cjs');
  held = require('../lib/scheduler/heldSchedulerTurns.cjs');
  chatRunner.attachWindow(fakeWindow());
});

afterEach(() => {
  held.setHoldProvider(null);
  chatRunner.attachWindow(null);
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a scheduler send under the hold is deferred: no broadcast, entry stored, disposition held', async () => {
  held.setHoldProvider(() => HOLD);
  const res = await chatRunner.enqueueExternalPrompt('tab-a', 'PLAN SETTLED digest', {
    origin: 'scheduler', sessionId: 'sess-a', cwd: '/proj', heldKind: 'settle-digest',
  });
  expect(res).toEqual({ disposition: 'held', reason: 'utilization-held' });
  expect(externalSends()).toHaveLength(0);
  const file = JSON.parse(fs.readFileSync(path.join(tmp, 'held-scheduler-turns.json'), 'utf8'));
  expect(file.entries).toHaveLength(1);
  expect(file.entries[0]).toMatchObject({
    tabId: 'tab-a', kind: 'settle-digest', prompt: 'PLAN SETTLED digest', sessionId: 'sess-a', cwd: '/proj',
    holdReason: 'utilization-held',
  });
});

test('a held send defaults its kind to scheduler-notice, even with no live window', async () => {
  chatRunner.attachWindow(null);
  held.setHoldProvider(() => HOLD);
  const res = await chatRunner.enqueueExternalPrompt('tab-k', 'job finished', { origin: 'scheduler' });
  expect(res.disposition).toBe('held');
  const file = JSON.parse(fs.readFileSync(path.join(tmp, 'held-scheduler-turns.json'), 'utf8'));
  expect(file.entries[0].kind).toBe('scheduler-notice');
});

test('one scheduler_turn_held audit line per tab per hold', async () => {
  held.setHoldProvider(() => HOLD);
  await chatRunner.enqueueExternalPrompt('tab-b', 'notice 1', { origin: 'scheduler' });
  await chatRunner.enqueueExternalPrompt('tab-b', 'notice 2', { origin: 'scheduler' });
  let lines = auditLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    tabId: 'tab-b', heldKind: 'scheduler-notice', reason: 'utilization-held', window: 'seven_day', percent: 93, threshold: 90,
  });
  // A different tab under the same hold audits once.
  await chatRunner.enqueueExternalPrompt('tab-c', 'notice 1', { origin: 'scheduler' });
  expect(auditLines()).toHaveLength(2);
  // A new hold (different reset) audits again for the same tab.
  held.setHoldProvider(() => ({ ...HOLD, resetsAt: '2026-12-07T18:00:00.000Z' }));
  await chatRunner.enqueueExternalPrompt('tab-b', 'notice 3', { origin: 'scheduler' });
  lines = auditLines();
  expect(lines).toHaveLength(3);
});

test('human, web-remote and admin-api sends under the hold still broadcast', async () => {
  held.setHoldProvider(() => HOLD);
  const ps = [
    chatRunner.enqueueExternalPrompt('tab-d', 'from the phone', { relay: 'web-remote' }),
    chatRunner.enqueueExternalPrompt('tab-d', 'from admin', { relay: 'admin-api' }),
    chatRunner.enqueueExternalPrompt('tab-d', 'from a human', { origin: 'human' }),
  ];
  expect(externalSends().map((s) => s.payload.prompt)).toEqual(['from the phone', 'from admin', 'from a human']);
  ackAll();
  for (const r of await Promise.all(ps)) expect(r.disposition).toBe('sent');
  expect(fs.existsSync(path.join(tmp, 'held-scheduler-turns.json'))).toBe(false);
  expect(auditLines()).toHaveLength(0);
});

test('no hold: a scheduler send broadcasts as before', async () => {
  const p = chatRunner.enqueueExternalPrompt('tab-e', 'job notice', { origin: 'scheduler', sessionId: 'sess-e' });
  expect(externalSends()).toHaveLength(1);
  expect(externalSends()[0].payload).toMatchObject({ tabId: 'tab-e', prompt: 'job notice', sessionId: 'sess-e' });
  ackAll();
  expect((await p).disposition).toBe('sent');
  expect(fs.existsSync(path.join(tmp, 'held-scheduler-turns.json'))).toBe(false);
  expect(auditLines()).toHaveLength(0);
});

test('hold returns mid-drain: the batch send is held without a new entry or audit line; originals stay', async () => {
  held.setHoldProvider(() => HOLD);
  for (const prompt of ['notice 1', 'notice 2', 'notice 3']) {
    await chatRunner.enqueueExternalPrompt('tab-f', prompt, { origin: 'scheduler', sessionId: 'sess-f', cwd: '/proj' });
  }
  const storePath = path.join(tmp, 'held-scheduler-turns.json');
  const before = JSON.parse(fs.readFileSync(storePath, 'utf8')).entries.map((e) => e.id).sort();
  expect(before).toHaveLength(3);
  const auditsBefore = auditLines().length;

  // The hold is still (again) active when drain sends: the seam holds the batch.
  const send = (tabId, prompt, extra) => chatRunner.enqueueExternalPrompt(tabId, prompt, extra);
  const direct = await chatRunner.enqueueExternalPrompt('tab-f', held.buildCoalescedPrompt([{ prompt: 'x', heldAt: '' }]), {
    origin: 'scheduler', heldBatch: true, sessionId: 'sess-f', cwd: '/proj',
  });
  expect(direct).toEqual({ disposition: 'held', reason: 'utilization-held' });
  const res = await held.drain({ send });
  expect(res).toEqual([{ tabId: 'tab-f', delivered: 0, dropped: 0 }]);
  expect(externalSends()).toHaveLength(0);
  expect(auditLines()).toHaveLength(auditsBefore);
  const left = JSON.parse(fs.readFileSync(storePath, 'utf8')).entries;
  expect(left.map((e) => e.id).sort()).toEqual(before);
  expect(left.some((e) => e.prompt.includes('The usage hold kept'))).toBe(false);

  // The hold clears: one delivery, one header, no nesting.
  held.setHoldProvider(() => null);
  const p = held.drain({ send });
  await new Promise((r) => setImmediate(r));
  expect(externalSends()).toHaveLength(1);
  const delivered = externalSends()[0].payload.prompt;
  expect(delivered.split('The usage hold kept').length - 1).toBe(1);
  expect(delivered).toContain('--- 3 of 3 ---\nnotice 3');
  ackAll();
  expect(await p).toEqual([{ tabId: 'tab-f', delivered: 3, dropped: 0 }]);
  expect(JSON.parse(fs.readFileSync(storePath, 'utf8')).entries).toHaveLength(0);
});
