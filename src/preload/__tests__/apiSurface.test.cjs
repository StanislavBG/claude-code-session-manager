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
      invoke: (channel, ...rest) => { recorded.push({ kind: 'invoke', channel, rest }); return Promise.resolve({ ok: true }); },
      send: (channel, ...rest) => { recorded.push({ kind: 'send', channel, rest }); },
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
    if (/^pty:/.test(r.channel) || ['app:test-fire-hook', 'app:pick-directory', 'app:reboot-app', 'watchers:add', 'plugins:install', 'voice:set-hotkey', 'voice:set-recording', 'config:write-json', 'config:write-text', 'mcp:check-server'].includes(r.channel)
      || /^(clipboard|shell|updater):/.test(r.channel)) {
      assert.ok(deny(r), `${key(r)} must be deny`);
    }
    if (r.remote === 'read') {
      assert.ok(!/(write|save|delete|set|install|spawn|kill|create|run|remove|open|reboot)/i.test(r.channel.replace(/^.*:/, '')) || r.kind === 'on', `${key(r)} looks mutating but is read`);
    }
  }
});

// mcp:check-server spawns the configured server's command, so the web remote must never reach it.
test('mcp.checkServer is listed and desktop-only (deny)', () => {
  const table = require('../apiSurface.cjs');
  const row = table.find((r) => r.ns === 'mcp' && r.method === 'checkServer');
  assert.ok(row, 'mcp.checkServer missing from apiSurface');
  assert.deepStrictEqual(
    { channel: row.channel, kind: row.kind, remote: row.remote },
    { channel: 'mcp:check-server', kind: 'invoke', remote: 'deny' },
  );
});

// scripts/start take a cwd and spawn/read on the desktop; stop must stay reachable for a remote Epic close.
test('appPreview rows carry the expected channels and remote policies', () => {
  const table = require('../apiSurface.cjs');
  const rows = table.filter((r) => r.ns === 'appPreview').map((r) => [r.method, r.channel, r.kind, r.remote]);
  assert.deepStrictEqual(rows, [
    ['scripts', 'appPreview:scripts', 'invoke', 'deny'],
    ['start', 'appPreview:start', 'invoke', 'deny'],
    ['stop', 'appPreview:stop', 'invoke', 'mutate'],
    ['list', 'appPreview:list', 'invoke', 'read'],
    ['onChanged', 'appPreview:changed', 'on', 'read'],
  ]);
});

// Rows whose preload wrapper transforms args in a way `pack` cannot describe. Pinned (not skipped):
// the exact preload output for the sentinel call must still match, so a change here fails loudly.
const KNOWN_UNDESCRIBED = {
  'config.readText': [{ path: '$0', maxBytes: undefined }], // deny; (path, opts) -> { path, maxBytes: opts?.maxBytes }
  'voice.setRecording': [true], // deny; !!coercion
  'voice.setTtsEnabled': [true], // !!coercion; remote forwards the raw boolean
  'updater.install': [{ force: false }], // deny; force === true
};

const CONDITIONAL_TRUTHY = { 'memory.aggregate': { refresh: true } };

test('every invoke/send row: pack (or its absence) matches what the real preload sends', () => {
  const table = require('../apiSurface.cjs');
  const SENT = ['$0', '$1', '$2', '$3'];
  const failures = [];
  for (const r of table) {
    if (r.kind !== 'invoke' && r.kind !== 'send') {
      assert.ok(!('pack' in r), `${key(r)}: pack is only valid on invoke/send rows`);
      continue;
    }
    const fn = exposedApi[r.ns][r.method];
    const spreads = new Set((r.pack || []).map((k, i) => (k.startsWith('...') ? i : -1)).filter((i) => i >= 0));
    const args = SENT.map((s, i) => (spreads.has(i) ? { workspace: s } : s));
    recorded = [];
    const res = fn(...args);
    if (res && typeof res.catch === 'function') res.catch(() => {});
    const { rest } = recorded[0];
    const k = key(r);
    if (KNOWN_UNDESCRIBED[k]) {
      assert.ok(!r.pack, `${k} is KNOWN_UNDESCRIBED so must not carry pack`);
      try { assert.deepStrictEqual(rest, KNOWN_UNDESCRIBED[k]); } catch { failures.push(`${k}: undescribed shape changed: ${JSON.stringify(rest)}`); }
      continue;
    }
    if (r.pack) {
      const expected = {};
      r.pack.forEach((name, i) => {
        if (name.startsWith('...')) Object.assign(expected, args[i]);
        else expected[name] = args[i];
      });
      Object.assign(expected, CONDITIONAL_TRUTHY[k]); // preload emits `true` instead of the truthy sentinel
      const ok = rest.length === 1 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])
        && JSON.stringify(Object.keys(rest[0])) === JSON.stringify(Object.keys(expected))
        && Object.keys(expected).every((n) => rest[0][n] === expected[n]);
      if (!ok) failures.push(`${k}: pack ${JSON.stringify(r.pack)} but preload sent ${JSON.stringify(rest)}`);
    } else {
      const ok = rest.length <= SENT.length && rest.every((v, i) => v === SENT[i]);
      if (!ok) failures.push(`${k}: no pack, but preload does not forward positionally: ${JSON.stringify(rest)}`);
    }
  }
  assert.deepStrictEqual(failures, [], failures.join('\n'));
});
