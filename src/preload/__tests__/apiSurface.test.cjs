/**
 * apiSurface.test.cjs — replays the real preload/index.cjs against a recording
 * ipcRenderer and asserts apiSurface.cjs matches it exactly, both directions.
 *
 * Run: timeout 120 npx vitest run apiSurface
 */

'use strict';

import { test, beforeAll } from 'vitest';
const assert = require('node:assert/strict');

let exposedApi;
let recorded = [];

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposedApi = api; } },
    ipcRenderer: {
      invoke: (channel) => { recorded.push({ kind: 'invoke', channel }); return Promise.resolve({ ok: true }); },
      send: (channel) => { recorded.push({ kind: 'send', channel }); },
      on: (channel) => { recorded.push({ kind: 'on', channel }); },
      removeListener: () => {},
    },
  },
};

beforeAll(() => {
  require('../index.cjs');
});

const key = (r) => `${r.ns}.${r.method}`;

function observe() {
  const out = [];
  for (const [ns, methods] of Object.entries(exposedApi)) {
    for (const [method, fn] of Object.entries(methods)) {
      recorded = [];
      if (/^on[A-Z]/.test(method)) {
        fn('T', () => {});
      } else {
        const res = fn({ question: 'q', name: 'n', target: {}, slug: 's' }, 'b', 'c');
        if (res && typeof res.catch === 'function') res.catch(() => {});
      }
      assert.strictEqual(recorded.length, 1, `${ns}.${method} should hit ipcRenderer exactly once`);
      let { kind, channel } = recorded[0];
      if (kind === 'on' && channel.endsWith(':T')) {
        kind = 'on-dynamic';
        channel = `${channel.slice(0, -1)}*`;
      }
      out.push({ ns, method, channel, kind });
    }
  }
  return out;
}

test('apiSurface table equals the preload surface exactly (no missing, no extra)', () => {
  const table = require('../apiSurface.cjs');
  const seen = observe();
  const tableMap = new Map(table.map((r) => [key(r), r]));
  assert.strictEqual(tableMap.size, table.length, 'duplicate rows in apiSurface');
  const seenMap = new Map(seen.map((r) => [key(r), r]));
  assert.deepStrictEqual([...tableMap.keys()].filter((k) => !seenMap.has(k)), [], 'rows with no preload method');
  assert.deepStrictEqual([...seenMap.keys()].filter((k) => !tableMap.has(k)), [], 'preload methods missing from table');
  for (const [k, s] of seenMap) {
    const t = tableMap.get(k);
    assert.deepStrictEqual({ channel: t.channel, kind: t.kind }, { channel: s.channel, kind: s.kind }, k);
  }
});

test('every row has a valid kind and remote policy; table is frozen', () => {
  const table = require('../apiSurface.cjs');
  assert.ok(Object.isFrozen(table));
  for (const r of table) {
    assert.ok(Object.isFrozen(r), key(r));
    assert.ok(['invoke', 'send', 'on', 'on-dynamic'].includes(r.kind), key(r));
    assert.ok(['read', 'mutate', 'deny'].includes(r.remote), `${key(r)} lacks a policy`);
  }
});

test('mandatory deny set and read-only invariants', () => {
  const table = require('../apiSurface.cjs');
  const deny = (r) => r.remote === 'deny';
  for (const r of table) {
    if (/^pty:/.test(r.channel) || ['app:test-fire-hook', 'app:pick-directory', 'app:reboot-app', 'watchers:add', 'plugins:install', 'voice:set-hotkey', 'voice:set-recording', 'config:write-json', 'config:write-text'].includes(r.channel)
      || /^(clipboard|shell|updater):/.test(r.channel)) {
      assert.ok(deny(r), `${key(r)} must be deny`);
    }
    if (r.remote === 'read') {
      assert.ok(!/(write|save|delete|set|install|spawn|kill|create|run|remove|open|reboot)/i.test(r.channel.replace(/^.*:/, '')) || r.kind === 'on', `${key(r)} looks mutating but is read`);
    }
  }
});
