/**
 * usageHoldRoute.test.cjs — GET /admin/usage-hold (lib/scheduler/usageHoldRoute.cjs)
 * with the hold and threshold injected as fakes.
 *
 * Run: timeout 300 npx vitest run src/main/lib/scheduler/__tests__/usageHoldRoute.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { EventEmitter } = require('node:events');
const { registerUsageHoldRoute } = require('../usageHoldRoute.cjs');

function fakeRes() {
  const res = new EventEmitter();
  res.status = null;
  res.body = null;
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}

function fakeReq(url = '/admin/usage-hold') {
  const req = new EventEmitter();
  req.url = url;
  req.method = 'GET';
  return req;
}

async function call(deps, url) {
  const handlers = new Map();
  registerUsageHoldRoute({ registerRoute: (m, p, h) => handlers.set(`${m} ${p}`, h) }, deps);
  expect([...handlers.keys()]).toEqual(['GET /admin/usage-hold']);
  const res = fakeRes();
  await handlers.get('GET /admin/usage-hold')(fakeReq(url), res);
  return res;
}

test('nothing held answers hold: null with the threshold', async () => {
  const res = await call({ usageHold: () => null, threshold: () => 90 });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, hold: null, threshold: 90 });
});

test('a hold in force is returned as-is, and a query string is ignored', async () => {
  const hold = {
    reason: 'utilization-held',
    window: 'seven_day',
    percent: 93,
    threshold: 90,
    resetsAt: '2026-11-25T08:00:00.000Z',
    detail: 'seven_day at 93% ≥ 90%',
  };
  const res = await call({ usageHold: () => hold, threshold: () => 90 }, '/admin/usage-hold?cwd=/x&hold=none');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, hold, threshold: 90 });
  expect(res.body.hold).toMatchObject({ window: 'seven_day', percent: 93, threshold: 90, resetsAt: '2026-11-25T08:00:00.000Z' });
});

test('a throwing hold dep answers 503 usage_hold_error', async () => {
  const res = await call({ usageHold: () => { throw new Error('state unreadable'); }, threshold: () => 90 });
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ ok: false, error: 'usage_hold_error', details: 'state unreadable' });
});

test('a throwing threshold dep answers 503 usage_hold_error', async () => {
  const res = await call({ usageHold: () => null, threshold: () => { throw new Error('no config'); } });
  expect(res.status).toBe(503);
  expect(res.body).toMatchObject({ ok: false, error: 'usage_hold_error', details: 'no config' });
});
