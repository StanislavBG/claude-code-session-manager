/**
 * seedDevPlugin.test.cjs — unit tests for the upgradeIfStale pass in src/main/seedDevPlugin.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/seedDevPlugin.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upgradeIfStale, compareSemver } = require('../seedDevPlugin.cjs');

const KEY = 'session-manager-dev@session-manager';
let home;

function writeJson(rel, obj) {
  const p = path.join(home, '.claude', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}
function installed(version) {
  writeJson('plugins/installed_plugins.json', { version: 2, plugins: { [KEY]: [{ scope: 'user', version }] } });
}
function enabled(on) {
  writeJson('settings.json', { enabledPlugins: { [KEY]: on } });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-dev-plugin-'));
  delete process.env.SM_SEED_DEV_PLUGIN_DISABLE;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(extra = {}) {
  const runUpdate = extra.runUpdate ?? vi.fn(async () => ({ ok: true, exitCode: 0 }));
  const writeLog = vi.fn();
  const p = upgradeIfStale({ home, bundledVersion: '0.2.0', runUpdate, writeLog, logger: {}, ...extra });
  return { runUpdate, writeLog, p };
}

test('compareSemver orders numerically', () => {
  expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0);
  expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
  expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
});

test('stale → update called', async () => {
  installed('0.1.0'); enabled(true);
  const { runUpdate, p } = run();
  await p;
  expect(runUpdate).toHaveBeenCalledTimes(1);
});

test('equal → not called', async () => {
  installed('0.2.0'); enabled(true);
  const { runUpdate, p } = run();
  await p;
  expect(runUpdate).not.toHaveBeenCalled();
});

test('not installed → not called', async () => {
  enabled(true);
  const { runUpdate, p } = run();
  await p;
  expect(runUpdate).not.toHaveBeenCalled();
});

test('disabled → not called', async () => {
  installed('0.1.0'); enabled(false);
  const { runUpdate, p } = run();
  await p;
  expect(runUpdate).not.toHaveBeenCalled();
});

test('kill-switch → not called', async () => {
  installed('0.1.0'); enabled(true);
  process.env.SM_SEED_DEV_PLUGIN_DISABLE = '1';
  const { runUpdate, p } = run();
  await p;
  expect(runUpdate).not.toHaveBeenCalled();
});

test('CLI failure → logged, resolves', async () => {
  installed('0.1.0'); enabled(true);
  const { writeLog, p } = run({ runUpdate: vi.fn(async () => ({ ok: false, exitCode: 1, error: 'boom' })) });
  await expect(p).resolves.toBeUndefined();
  expect(writeLog).toHaveBeenCalledTimes(1);
  const { writeLog: wl2, p: p2 } = run({ runUpdate: vi.fn(async () => { throw new Error('x'); }) });
  await expect(p2).resolves.toBeUndefined();
  expect(wl2).toHaveBeenCalledTimes(1);
});
