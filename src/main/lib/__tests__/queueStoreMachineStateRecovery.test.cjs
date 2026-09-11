/**
 * queueStoreMachineStateRecovery.test.cjs — a torn `scheduler-machine.json`
 * must recover instead of poisoning every read with `unreadable` (which
 * halts tickQueue/runDueJobs machine-wide — the user-visible "Run now"
 * hard error "queue.json is unreadable — scheduling halted").
 *
 * fixtures/scheduler-machine.json.corrupt-1789147548 is a byte-for-byte copy
 * of the REAL torn file recovered live on 2026-09-11 — not hand-typed. Its
 * shape: a complete, valid, parseable object (paused: null) followed by the
 * orphaned tail of a longer previous write (an incomplete `resumeAt` string
 * fragment with no reconstructable `"paused"` object around it).
 *
 * Never writes to the real ~/.claude/session-manager/ — HOME is pointed at a
 * fresh temp dir per test and the module is re-required so its module-level
 * MACHINE_STATE_PATH constant is recomputed against it.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/queueStoreMachineStateRecovery.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'fixtures', 'scheduler-machine.json.corrupt-1789147548');

// queueStore.cjs is required via Node's own require() (this is a .cjs file,
// not transformed ESM) and bakes os.homedir() into a top-level const
// (MACHINE_STATE_PATH, MACHINE_STATE_LOG_CWD) at first require. vi.resetModules()
// only resets vitest's ESM module graph, so it does NOT clear Node's own
// require.cache — purge it directly (same pattern as historyRollup.test.cjs)
// or every test after the first keeps pointing at the FIRST test's tmpHome.
function purgeRequireCache() {
  try { delete require.cache[require.resolve('../queueStore.cjs')]; } catch { /* not loaded yet */ }
}

const realHome = process.env.HOME;
let tmpHome;
let queueStore;
let machineStatePath;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'queueStore-home-'));
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, 'Projects', 'session-manager'), { recursive: true });
  process.env.HOME = tmpHome;
  purgeRequireCache();
  queueStore = require('../queueStore.cjs');
  machineStatePath = queueStore.MACHINE_STATE_PATH;
  expect(machineStatePath.startsWith(tmpHome)).toBe(true); // sanity: never the real file
});

afterEach(async () => {
  process.env.HOME = realHome;
  purgeRequireCache();
  await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

test('findLongestValidJsonPrefix recovers the complete leading object from the real torn fixture', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const result = queueStore.findLongestValidJsonPrefix(raw);
  expect(result).not.toBeNull();
  expect(result.prefixLength).toBeLessThan(raw.length); // there really is an orphaned tail
  expect(result.value.paused).toBeNull();
  expect(result.value.lastRunAt).toBe('2026-09-11T10:00:14.441Z');
  expect(result.value.config.concurrencyCap).toBe(4);
});

test('readMergedSync recovers a torn machine-state file instead of marking it unreadable', () => {
  fs.copyFileSync(FIXTURE, machineStatePath);

  const state = queueStore.readMergedSync();

  expect(state.unreadable).toBeUndefined();
  expect(state.machineStateRecovered).toBe(true);
  expect(state.machineStateRecoveryMode).toBe('prefix');
  expect(state.paused).toBeNull();
  expect(state.lastRunAt).toBe('2026-09-11T10:00:14.441Z');

  // The file is rewritten atomically from the recovered object — a second
  // read must come back clean with no recovery flag.
  const rewritten = fs.readFileSync(machineStatePath, 'utf8');
  expect(() => JSON.parse(rewritten)).not.toThrow();
  const second = queueStore.readMergedSync();
  expect(second.machineStateRecovered).toBeUndefined();
  expect(second.paused).toBeNull();
});

test('a file with no valid JSON prefix at all falls back to defaults, never to unreadable', () => {
  fs.writeFileSync(machineStatePath, 'not json at all {{{ this never balances');

  const state = queueStore.readMergedSync();

  expect(state.unreadable).toBeUndefined();
  expect(state.machineStateRecovered).toBe(true);
  expect(state.machineStateRecoveryMode).toBe('default');
  expect(state.config).toEqual({});
  expect(state.paused).toBeNull();

  // Rewritten to a clean, parseable default doc so the engine keeps ticking.
  const rewritten = fs.readFileSync(machineStatePath, 'utf8');
  expect(() => JSON.parse(rewritten)).not.toThrow();
});

test('a genuinely missing file is a legitimately empty first-boot state, not a recovery', () => {
  const state = queueStore.readMergedSync();
  expect(state.unreadable).toBeUndefined();
  expect(state.machineStateRecovered).toBeUndefined();
});

test('readMerged (async) recovers the same real fixture', async () => {
  fs.copyFileSync(FIXTURE, machineStatePath);

  const state = await queueStore.readMerged();

  expect(state.unreadable).toBeUndefined();
  expect(state.machineStateRecovered).toBe(true);
  expect(state.machineStateRecoveryMode).toBe('prefix');
  expect(state.lastRunAt).toBe('2026-09-11T10:00:14.441Z');
});
