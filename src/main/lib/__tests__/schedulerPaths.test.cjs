/**
 * schedulerPaths.test.cjs — every machine-wide scheduler root resolves lazily
 * through lib/schedulerPaths.cjs, so SM_SCHEDULER_HOME redirects ALL of them.
 *
 * SM_SCHEDULER_HOME is set to a temp dir BEFORE the modules under test are
 * required; nothing here touches ~/.claude/session-manager.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerPaths.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
// Every module the PRD routes through the resolver — a half-redirect in any of
// them fails the source scan below.
const ROUTED_MODULES = [
  'src/main/scheduler.cjs',
  'src/main/queueOps.cjs',
  'src/main/lib/queueStore.cjs',
  'src/main/lib/sessionSlots.cjs',
  'src/main/lib/localAdminHttp.cjs',
  'src/main/lib/watchdogHelpers.cjs',
  'src/main/health.cjs',
  'scripts/scheduler-watchdog.cjs',
  'src/main/lib/auditLog.cjs',
  'src/main/lib/historyRollup.cjs',
  'src/main/lib/queueHistory.cjs',
  'src/main/lib/instanceLock.cjs',
  'src/main/lib/procName.cjs',
  'src/main/heapSnapshot.cjs',
  'scripts/scheduler-mcp-server.cjs',
  'scripts/replay-verdicts.cjs',
  'scripts/audit-ops-hygiene.cjs',
];

const ENV_KEYS = ['SM_SCHEDULER_HOME', 'SM_SCHEDULER_LOG_CWD', 'SM_ADMIN_TOKEN_PATH', 'SM_DEV', 'SM_E2E'];
const savedEnv = {};
let tmpHome;
let sp;

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ['SM_SCHEDULER_LOG_CWD', 'SM_ADMIN_TOKEN_PATH', 'SM_DEV', 'SM_E2E']) delete process.env[k];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-scheduler-home-'));
  process.env.SM_SCHEDULER_HOME = tmpHome;
  sp = require('../schedulerPaths.cjs');
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('every resolver lands under SM_SCHEDULER_HOME', () => {
  expect(sp.schedulerHome()).toBe(tmpHome);
  const plans = path.join(tmpHome, 'scheduled-plans');
  expect(sp.scheduledPlansRoot()).toBe(plans);
  expect(sp.runsDir()).toBe(path.join(plans, 'runs'));
  expect(sp.prdsRoot()).toBe(path.join(plans, 'prds'));
  expect(sp.legacyQueuePath()).toBe(path.join(plans, 'queue.json'));
  expect(sp.machineStatePath()).toBe(path.join(tmpHome, 'scheduler-machine.json'));
  expect(sp.schedulerStatePath()).toBe(path.join(tmpHome, 'scheduler-state.json'));
  expect(sp.heartbeatPath()).toBe(path.join(tmpHome, 'scheduler-heartbeat.log'));
  expect(sp.sessionSlotsConfigPath()).toBe(path.join(tmpHome, 'session-slots-config.json'));
  expect(sp.adminTokenPath()).toBe(path.join(tmpHome, 'admin-api.json'));
  expect(sp.watchdogLogsDir()).toBe(path.join(tmpHome, 'logs'));
});

test('resolvers are lazy: changing the env changes the result without re-requiring', () => {
  const other = path.join(tmpHome, 'other');
  process.env.SM_SCHEDULER_HOME = other;
  try {
    expect(sp.runsDir()).toBe(path.join(other, 'scheduled-plans', 'runs'));
  } finally {
    process.env.SM_SCHEDULER_HOME = tmpHome;
  }
});

test('default home is ~/.claude/session-manager', () => {
  delete process.env.SM_SCHEDULER_HOME;
  try {
    expect(sp.schedulerHome()).toBe(path.join(os.homedir(), '.claude', 'session-manager'));
  } finally {
    process.env.SM_SCHEDULER_HOME = tmpHome;
  }
});

test('adminTokenPath keeps the SM_ADMIN_TOKEN_PATH > SM_DEV > SM_E2E ladder', () => {
  try {
    process.env.SM_E2E = '1';
    expect(sp.adminTokenPath()).toBe(path.join(tmpHome, 'admin-api.e2e.json'));
    process.env.SM_DEV = '1';
    expect(sp.adminTokenPath()).toBe(path.join(tmpHome, 'admin-api.dev.json'));
    process.env.SM_ADMIN_TOKEN_PATH = '/tmp/explicit-token.json';
    expect(sp.adminTokenPath()).toBe('/tmp/explicit-token.json');
  } finally {
    delete process.env.SM_E2E; delete process.env.SM_DEV; delete process.env.SM_ADMIN_TOKEN_PATH;
  }
});

test('machineStateLogCwd is the literal ~/Projects/session-manager unless overridden (never process.cwd())', () => {
  expect(sp.machineStateLogCwd()).toBe(path.join(os.homedir(), 'Projects', 'session-manager'));
  process.env.SM_SCHEDULER_LOG_CWD = '/tmp/log-cwd';
  try {
    expect(sp.machineStateLogCwd()).toBe('/tmp/log-cwd');
  } finally {
    delete process.env.SM_SCHEDULER_LOG_CWD;
  }
});

test('queueStore: paths and readMergedSync resolve under the override', () => {
  const queueStore = require('../queueStore.cjs');
  expect(queueStore.MACHINE_STATE_PATH).toBe(sp.machineStatePath());
  expect(queueStore.LEGACY_QUEUE_PATH).toBe(sp.legacyQueuePath());
  fs.writeFileSync(sp.machineStatePath(), JSON.stringify({ paused: null, lastRunAt: 4242 }));
  const merged = queueStore.readMergedSync();
  expect(merged.unreadable).toBeUndefined();
  expect(merged.lastRunAt).toBe(4242);
});

test('sessionSlots: persisted cap is read from and written under the override', () => {
  const slots = require('../sessionSlots.cjs');
  slots.setCap(7);
  const cfg = sp.sessionSlotsConfigPath();
  expect(JSON.parse(fs.readFileSync(cfg, 'utf8')).cap).toBe(7);
  expect(slots.totalSlots()).toBe(7);
  slots.__resetForTests?.();
});

test('localAdminHttp: TOKEN_PATH / resolveTokenPath follow the resolver', () => {
  const admin = require('../localAdminHttp.cjs');
  expect(admin.TOKEN_PATH).toBe(path.join(tmpHome, 'admin-api.json'));
  expect(admin.resolveTokenPath()).toBe(admin.TOKEN_PATH);
});

test('scheduler / queueOps / watchdogHelpers path exports follow the override', () => {
  const scheduler = require('../../scheduler.cjs');
  expect(scheduler.ROOT).toBe(sp.scheduledPlansRoot());
  expect(scheduler.PRDS_DIR).toBe(sp.prdsRoot());
  expect(scheduler.RUNS_DIR).toBe(sp.runsDir());
  expect(scheduler.SCHEDULER_STATE_PATH).toBe(sp.schedulerStatePath());
  const queueOps = require('../../queueOps.cjs');
  expect(queueOps.PRDS_DIR).toBe(sp.prdsRoot());
  expect(queueOps.PRDS_ARCHIVE_DIR).toBe(path.join(sp.scheduledPlansRoot(), 'prds-archived'));
  const wd = require('../watchdogHelpers.cjs');
  expect(wd.DEFAULT_HEARTBEAT_PATH).toBe(sp.heartbeatPath());
  expect(wd.DEFAULT_LOCK_PATH).toBe(sp.historyRollupLockPath());
  expect(wd.DEFAULT_STAMP_PATH).toBe(sp.historyRollupStampPath());
  expect(wd.DEFAULT_RELAUNCH_STATE_PATH).toBe(sp.watchdogRelaunchStatePath());
});

test('auditLog, historyRollup, queueHistory, instanceLock, procName, heapSnapshot land under SM_SCHEDULER_HOME', () => {
  const saved = {};
  for (const k of ['SM_HISTORY_PATH_OVERRIDE', 'SM_SCHEDULER_LOCK_PATH']) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const auditLog = require('../auditLog.cjs');
    expect(auditLog.auditLogPath()).toBe(path.join(tmpHome, 'audit-log.jsonl'));
    auditLog.appendAuditEvent('schedulerPaths_test', {});
    expect(fs.existsSync(path.join(tmpHome, 'audit-log.jsonl'))).toBe(true);
    expect(require('../historyRollup.cjs').historyRollupPath()).toBe(path.join(tmpHome, 'history-rollup.jsonl'));
    expect(require('../queueHistory.cjs').historyPath()).toBe(path.join(tmpHome, 'scheduled-plans', 'history.jsonl'));
    expect(require('../instanceLock.cjs').lockPath()).toBe(path.join(tmpHome, 'scheduler-owner.lock'));
    expect(require('../procName.cjs').procnamesRoot()).toBe(path.join(tmpHome, 'procnames'));
    expect(sp.heapSnapshotDir()).toBe(tmpHome);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test.each(ROUTED_MODULES)('%s derives no home-rooted path from os.homedir() itself', (rel) => {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const offenders = src.split('\n').filter((l) => {
    const t = l.trim();
    if (t.startsWith('*') || t.startsWith('//')) return false;
    return /os\.homedir\(\).*(\.claude|session-manager|scheduled-plans)/.test(l)
      || (/os\.homedir\(\)/.test(l) && /Projects/.test(l));
  });
  expect(offenders).toEqual([]);
  expect(src).toMatch(/schedulerPaths\.cjs/);
});
