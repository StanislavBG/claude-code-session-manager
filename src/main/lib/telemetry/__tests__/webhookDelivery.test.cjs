/**
 * webhookDelivery.test.cjs — at-least-once, HMAC-signed delivery of event-log
 * events to loopback webhook subscribers (webhookDelivery.cjs).
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/webhookDelivery.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let tmpHome;
let prevSchedulerHome;
let reg;
let log;
let delivery;
const dirs = [];

beforeAll(() => {
  prevSchedulerHome = process.env.SM_SCHEDULER_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-whd-home-'));
  process.env.SM_SCHEDULER_HOME = tmpHome;
  reg = require('../webhookRegistry.cjs');
  log = require('../../epic/epicEventLog.cjs');
  delivery = require('../webhookDelivery.cjs');
});

afterAll(() => {
  if (prevSchedulerHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedulerHome;
  for (const d of [tmpHome, ...dirs]) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  log._resetForTests();
  delivery._resetForTests();
});

function newCwd() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-whd-cwd-'));
  dirs.push(d);
  return d;
}

/** Fake fetch recording every call; `status(call)` decides the response. */
function fakeFetch(status = () => 200) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    const s = status(call, calls.length);
    if (s instanceof Error) throw s;
    return { ok: s >= 200 && s < 300, status: s };
  };
  return { fn, calls };
}

test('no subscriptions → no-op: no fetch, no state file', async () => {
  const cwd = newCwd();
  await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  const f = fakeFetch();
  const r = await delivery.deliverPending({ cwd, now: () => 1000, fetch: f.fn });
  expect(r.delivered).toBe(0);
  expect(f.calls.length).toBe(0);
  expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'webhooks', 'delivery-state.json'))).toBe(false);
});

test('signature: X-SM-Signature is hex HMAC-SHA256 of the exact body with the subscriber secret', async () => {
  const cwd = newCwd();
  const { id, secret } = await reg.addSubscription({ cwd, url: 'http://127.0.0.1:9/hook', kinds: ['job.queued'] });
  await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued', slug: 'a' });
  const f = fakeFetch();
  const r = await delivery.deliverPending({ cwd, now: () => 1000, fetch: f.fn });
  expect(r.delivered).toBe(1);
  expect(f.calls.length).toBe(1);
  const { url, init, body } = f.calls[0];
  expect(url).toBe('http://127.0.0.1:9/hook');
  expect(init.method).toBe('POST');
  const expected = crypto.createHmac('sha256', secret).update(init.body).digest('hex');
  expect(init.headers['X-SM-Signature']).toBe(expected);
  expect(init.headers['X-SM-Signature']).toMatch(/^[0-9a-f]{64}$/);
  expect(init.headers['Content-Type']).toBe('application/json');
  expect(init.signal).toBeDefined();
  expect(body.subscriptionId).toBe(id);
  expect(body.event).toMatchObject({ seq: 1, epicId: 'e1', kind: 'job.queued', slug: 'a' });
});

test('cursor advances only on 2xx; a failure stops the subscriber and backs off', async () => {
  const cwd = newCwd();
  const { id } = await reg.addSubscription({ cwd, url: 'http://localhost:9/', kinds: ['job.queued'] });
  for (let i = 0; i < 3; i++) await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued', n: i });
  // seq 1 → 200, seq 2 → 500.
  const f = fakeFetch((call) => (call.body.event.seq === 1 ? 200 : 500));
  const r = await delivery.deliverPending({ cwd, now: () => 1000, fetch: f.fn });
  expect(r.delivered).toBe(1);
  expect(r.failed).toBe(1);
  expect(f.calls.map((c) => c.body.event.seq)).toEqual([1, 2]); // stopped at first failure
  const st = await reg.readDeliveryState({ cwd });
  expect(st.cursors[id].e1).toBe(1);
  expect(st.backoff[id].failures).toBe(1);
  expect(st.backoff[id].nextAttemptAt).toBeGreaterThan(1000);

  // A non-2xx such as 302 also does not advance.
  const f302 = fakeFetch(() => 302);
  await delivery.deliverPending({ cwd, now: () => st.backoff[id].nextAttemptAt, fetch: f302.fn });
  const st2 = await reg.readDeliveryState({ cwd });
  expect(st2.cursors[id].e1).toBe(1);
  expect(st2.backoff[id].failures).toBe(2);
  // Backoff grows and is capped.
  expect(st2.backoff[id].nextAttemptAt - st.backoff[id].nextAttemptAt).toBeGreaterThan(st.backoff[id].nextAttemptAt - 1000);
  expect(st2.backoff[id].nextAttemptAt - st.backoff[id].nextAttemptAt).toBeLessThanOrEqual(delivery.MAX_BACKOFF_MS);
});

test('retry after failure: skipped while backing off, then redelivers from the cursor and clears backoff', async () => {
  const cwd = newCwd();
  const { id } = await reg.addSubscription({ cwd, url: 'http://[::1]:9/x', kinds: ['job.queued'] });
  await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  const down = fakeFetch(() => new Error('ECONNREFUSED'));
  await delivery.deliverPending({ cwd, now: () => 1000, fetch: down.fn });
  expect(down.calls.length).toBe(1);
  const { nextAttemptAt } = (await reg.readDeliveryState({ cwd })).backoff[id];

  const up = fakeFetch();
  const early = await delivery.deliverPending({ cwd, now: () => nextAttemptAt - 1, fetch: up.fn });
  expect(up.calls.length).toBe(0);
  expect(early.backedOff).toBe(1);

  const r = await delivery.deliverPending({ cwd, now: () => nextAttemptAt, fetch: up.fn });
  expect(r.delivered).toBe(2);
  expect(up.calls.map((c) => c.body.event.seq)).toEqual([1, 2]);
  const st = await reg.readDeliveryState({ cwd });
  expect(st.cursors[id].e1).toBe(2);
  expect(st.backoff[id]).toBeUndefined();
});

test('bounded attempts per pass: a pass sends at most MAX_DELIVERIES_PER_PASS per subscriber', async () => {
  const cwd = newCwd();
  const { id } = await reg.addSubscription({ cwd, url: 'http://127.0.0.1:9/', kinds: ['job.queued'] });
  const n = delivery.MAX_DELIVERIES_PER_PASS + 5;
  for (let i = 0; i < n; i++) await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  const f = fakeFetch();
  await delivery.deliverPending({ cwd, now: () => 1000, fetch: f.fn });
  expect(f.calls.length).toBe(delivery.MAX_DELIVERIES_PER_PASS);
  await delivery.deliverPending({ cwd, now: () => 2000, fetch: f.fn });
  expect(f.calls.length).toBe(n);
  expect((await reg.readDeliveryState({ cwd })).cursors[id].e1).toBe(n);
});

test('crash replay: a delivery whose cursor write never landed is re-sent; nothing is skipped', async () => {
  const cwd = newCwd();
  const { id } = await reg.addSubscription({ cwd, url: 'http://127.0.0.1:9/', kinds: ['job.queued'] });
  for (let i = 0; i < 3; i++) await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  // The receiver accepted seqs 1-3 but the process died before the cursor
  // write for 2-3 landed — simulated by rolling the persisted cursor back to 1
  // and dropping in-memory state.
  const f1 = fakeFetch();
  await delivery.deliverPending({ cwd, now: () => 1000, fetch: f1.fn });
  expect(f1.calls.length).toBe(3);
  await reg.updateDeliveryState({ cwd, mutate: (s) => { s.cursors[id].e1 = 1; } });
  delivery._resetForTests();

  const f2 = fakeFetch();
  await delivery.deliverPending({ cwd, now: () => 2000, fetch: f2.fn });
  expect(f2.calls.map((c) => c.body.event.seq)).toEqual([2, 3]); // replay, no skip
  // Events appended after the crash also arrive, in order.
  await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  const f3 = fakeFetch();
  await delivery.deliverPending({ cwd, now: () => 3000, fetch: f3.fn });
  expect(f3.calls.map((c) => c.body.event.seq)).toEqual([4]);
});

test('kinds filter: only subscribed kinds are delivered, per subscriber, across Epics', async () => {
  const cwd = newCwd();
  const a = await reg.addSubscription({ cwd, url: 'http://127.0.0.1:9/a', kinds: ['job.queued'] });
  const b = await reg.addSubscription({ cwd, url: 'http://127.0.0.1:9/b', kinds: ['validator.verdict', 'epic.minted'] });
  await log.appendEpicEvent(cwd, 'e1', { kind: 'epic.minted' });
  await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  await log.appendEpicEvent(cwd, 'e2', { kind: 'validator.verdict' });
  await log.appendEpicEvent(cwd, 'e2', { kind: 'job.status_changed' });
  const f = fakeFetch();
  await delivery.deliverPending({ cwd, now: () => 1000, fetch: f.fn });
  const byUrl = (u) => f.calls.filter((c) => c.url === u).map((c) => `${c.body.event.epicId}:${c.body.event.kind}`).sort();
  expect(byUrl('http://127.0.0.1:9/a')).toEqual(['e1:job.queued']);
  expect(byUrl('http://127.0.0.1:9/b')).toEqual(['e1:epic.minted', 'e2:validator.verdict']);
  const st = await reg.readDeliveryState({ cwd });
  expect(st.cursors[a.id]).toEqual({ e1: 2 });
  expect(st.cursors[b.id]).toEqual({ e1: 1, e2: 1 });
});

test('a subscription URL that is no longer loopback is never fetched', async () => {
  const cwd = newCwd();
  await reg.addSubscription({ cwd, url: 'http://127.0.0.1:9/', kinds: ['job.queued'] });
  const file = path.join(cwd, 'session-manager-operations', 'webhooks', 'subscriptions.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.subscriptions[0].url = 'http://example.com/';
  fs.writeFileSync(file, JSON.stringify(raw));
  await log.appendEpicEvent(cwd, 'e1', { kind: 'job.queued' });
  const f = fakeFetch();
  const r = await delivery.deliverPending({ cwd, now: () => 1000, fetch: f.fn });
  expect(f.calls.length).toBe(0);
  expect(r.refused).toBe(1);
});
