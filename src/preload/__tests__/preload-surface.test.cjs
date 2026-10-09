/**
 * preload-surface.test.cjs — guards against a declared api.d.ts method with
 * no matching contextBridge expose in preload/index.cjs (the gap this PRD
 * closes: installSelfScheduleGuard was declared in api.d.ts and handled in
 * index.cjs, but never exposed on the preload bridge, so the renderer could
 * never actually call it).
 *
 * Outside an Electron runtime, `require('electron')` resolves to a path
 * string (see node_modules/electron/index.js), not {contextBridge,
 * ipcRenderer} — and vi.mock('electron') does not reliably intercept a
 * plain require() of an npm package from a .cjs test file under this
 * project's vitest setup. So this stubs 'electron' directly in Node's
 * require cache before requiring preload/index.cjs, which is the real
 * module under test here.
 *
 * Run: timeout 120 npx vitest run src/preload/__tests__/preload-surface.test.cjs
 */

'use strict';

import { test, beforeAll } from 'vitest';
const assert = require('node:assert/strict');

let exposedApi;
const invokeCalls = [];

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    contextBridge: {
      exposeInMainWorld: (_name, api) => { exposedApi = api; },
    },
    ipcRenderer: {
      invoke: (channel, payload) => {
        invokeCalls.push({ channel, payload });
        return Promise.resolve({ ok: true });
      },
      send: () => {},
      on: () => {},
      removeListener: () => {},
    },
  },
};

beforeAll(() => {
  require('../index.cjs');
});

test('exposes installSelfScheduleGuard, wired to app:install-self-schedule-guard', async () => {
  assert.strictEqual(typeof exposedApi.app.installSelfScheduleGuard, 'function');
  await exposedApi.app.installSelfScheduleGuard('/tmp/proj');
  const call = invokeCalls.find((c) => c.channel === 'app:install-self-schedule-guard');
  assert.ok(call, 'expected an invoke call on app:install-self-schedule-guard');
  assert.deepStrictEqual(call.payload, { cwd: '/tmp/proj' });
});

test('schedule.resetJob sends cwd only when given', async () => {
  invokeCalls.length = 0;
  await exposedApi.schedule.resetJob('my-slug');
  await exposedApi.schedule.resetJob('my-slug', '/tmp/proj');
  const calls = invokeCalls.filter((c) => c.channel === 'schedule:reset-job');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[0].payload, { slug: 'my-slug' });
  assert.deepStrictEqual(calls[1].payload, { slug: 'my-slug', cwd: '/tmp/proj' });
});

test('customerFeedback exposes nine methods wired to customerFeedback:* channels', async () => {
  const expected = {
    submit: 'customerFeedback:submit',
    list: 'customerFeedback:list',
    refreshStatus: 'customerFeedback:refresh-status',
    markSeen: 'customerFeedback:mark-seen',
    ownerInfo: 'customerFeedback:owner-info',
    inboxPull: 'customerFeedback:inbox-pull',
    inboxList: 'customerFeedback:inbox-list',
    inboxSetStatus: 'customerFeedback:inbox-set-status',
    inboxLinkEpic: 'customerFeedback:inbox-link-epic',
  };
  assert.deepStrictEqual(Object.keys(exposedApi.customerFeedback).sort(), Object.keys(expected).sort());
  for (const [method, channel] of Object.entries(expected)) {
    invokeCalls.length = 0;
    const payload = { probe: method };
    await exposedApi.customerFeedback[method](payload);
    assert.strictEqual(invokeCalls.length, 1);
    assert.strictEqual(invokeCalls[0].channel, channel);
  }
  invokeCalls.length = 0;
  await exposedApi.customerFeedback.submit({ title: 't', body: 'b', tag: 'bug' });
  assert.deepStrictEqual(invokeCalls[0].payload, { title: 't', body: 'b', tag: 'bug' });
});
