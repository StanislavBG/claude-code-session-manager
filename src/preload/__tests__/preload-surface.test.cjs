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

test('mcp.checkServer forwards the request unchanged to mcp:check-server', async () => {
  assert.strictEqual(typeof exposedApi.mcp.checkServer, 'function');
  const req = { source: 'project', name: 'github', cwd: '/tmp/proj' };
  invokeCalls.length = 0;
  await exposedApi.mcp.checkServer(req);
  assert.deepStrictEqual(invokeCalls, [{ channel: 'mcp:check-server', payload: req }]);
});

test('updater namespace exposes six methods wired to updater:* channels', async () => {
  const u = exposedApi.updater;
  assert.ok(u, 'expected exposedApi.updater');
  assert.deepStrictEqual(
    Object.keys(u).sort(),
    ['cancelDeferred', 'check', 'install', 'onStatus', 'setEnabled', 'status'],
  );
  const cases = [
    ['status', [], 'updater:status', undefined],
    ['check', [], 'updater:check', undefined],
    ['install', [true], 'updater:install', { force: true }],
    ['install', ['yes'], 'updater:install', { force: false }],
    ['cancelDeferred', [], 'updater:cancel-deferred', undefined],
    ['setEnabled', [false], 'updater:set-enabled', { enabled: false }],
  ];
  for (const [method, args, channel, payload] of cases) {
    invokeCalls.length = 0;
    await u[method](...args);
    assert.strictEqual(invokeCalls.length, 1);
    assert.strictEqual(invokeCalls[0].channel, channel);
    assert.deepStrictEqual(invokeCalls[0].payload, payload);
  }
  assert.strictEqual(typeof u.onStatus(() => {}), 'function');
});

test('appPreview exposes five methods wired to appPreview:* channels; onChanged forwards the payload', async () => {
  const p = exposedApi.appPreview;
  assert.ok(p, 'expected exposedApi.appPreview');
  assert.deepStrictEqual(Object.keys(p).sort(), ['list', 'onChanged', 'scripts', 'start', 'stop']);
  const cases = [
    ['scripts', [{ cwd: '/tmp/proj', epicId: 'e1' }], 'appPreview:scripts', { cwd: '/tmp/proj', epicId: 'e1' }],
    ['start', [{ cwd: '/tmp/proj', epicId: 'e1', script: 'dev' }], 'appPreview:start', { cwd: '/tmp/proj', epicId: 'e1', script: 'dev' }],
    ['stop', [{ epicId: 'e1' }], 'appPreview:stop', { epicId: 'e1' }],
    ['list', [], 'appPreview:list', undefined],
  ];
  for (const [method, args, channel, payload] of cases) {
    invokeCalls.length = 0;
    await p[method](...args);
    assert.deepStrictEqual(invokeCalls, [{ channel, payload }]);
  }
  const electron = require('electron');
  const origOn = electron.ipcRenderer.on;
  const origRemove = electron.ipcRenderer.removeListener;
  let registered = null;
  let removed = null;
  electron.ipcRenderer.on = (channel, listener) => { registered = { channel, listener }; };
  electron.ipcRenderer.removeListener = (channel, listener) => { removed = { channel, listener }; };
  try {
    const got = [];
    const unsub = p.onChanged((state) => got.push(state));
    assert.strictEqual(registered.channel, 'appPreview:changed');
    const state = { epicId: 'e1', status: 'running' };
    registered.listener({}, state);
    assert.deepStrictEqual(got, [state]);
    assert.strictEqual(typeof unsub, 'function');
    unsub();
    assert.deepStrictEqual(removed, registered);
  } finally {
    electron.ipcRenderer.on = origOn;
    electron.ipcRenderer.removeListener = origRemove;
  }
});
