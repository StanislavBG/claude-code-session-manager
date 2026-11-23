/**
 * taskIpc.test.cjs — renderer IPC for the Scheduler Tasks section
 * (lib/tasks/taskIpc.cjs) with a mocked ipcMain, a tmp SM_SCHEDULER_HOME
 * (switch store) and a tmp project cwd (ledger).
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskIpc.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledger = require('../taskLedger.cjs');
const taskSwitch = require('../taskSwitch.cjs');
const sessionSlots = require('../../scheduler/sessionSlots.cjs');
const auditLog = require('../../telemetry/auditLog.cjs');
const { registerTaskIpc } = require('../taskIpc.cjs');

let cwd;
let home;
let schedHome;
let prevSchedHome;
let handlers;
let reserveSpy;
let auditSpy;

function fakeIpcMain() {
  handlers = new Map();
  return { handle: (ch, fn) => { handlers.set(ch, fn); } };
}
const invoke = (ch, payload) => handlers.get(ch)({}, payload);

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskipc-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskipc-home-'));
  schedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskipc-sched-'));
  prevSchedHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = schedHome;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  ledger._resetForTests();
  taskSwitch._resetForTests();
  reserveSpy = vi.spyOn(sessionSlots, 'setInteractiveReserve').mockImplementation((on) => !!on);
  auditSpy = vi.spyOn(auditLog, 'appendAuditEvent').mockImplementation(() => {});
  registerTaskIpc({ ipcMain: fakeIpcMain() });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevSchedHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedHome;
  for (const d of [cwd, home, schedHome]) fs.rmSync(d, { recursive: true, force: true });
});

function startRow(taskId, over = {}) {
  return {
    taskId, cwd, agent: 'dev-lead', model: 'claude-sonnet-4-5', effort: 'medium', missionId: null,
    priority: 'batch', caller: { pipeline: 'burrow', runId: 'r1', step: 'draft', attempt: 1 },
    startedAt: new Date().toISOString(), timeoutSec: 600, slotWaitSec: 0, runtimeCwd: cwd,
    prompt: `prompt for ${taskId}`, ...over,
  };
}

test('registers exactly the four channels and syncs the reserve once at registration', () => {
  expect([...handlers.keys()].sort()).toEqual(['tasks:get', 'tasks:get-switch', 'tasks:list', 'tasks:set-switch']);
  expect(reserveSpy).toHaveBeenCalledTimes(1);
  expect(reserveSpy).toHaveBeenLastCalledWith(false);
});

test('tasks:list passes filters to listTasks and returns ok rows', async () => {
  await ledger.appendTaskStart(cwd, startRow('t-a', { agent: 'dev-lead' }));
  await ledger.appendTaskStart(cwd, startRow('t-b', { agent: 'architect' }));
  const all = await invoke('tasks:list', { cwd });
  expect(all.ok).toBe(true);
  expect(all.total).toBe(2);
  const filtered = await invoke('tasks:list', { cwd, agent: 'architect', limit: 10, offset: 0 });
  expect(filtered.ok).toBe(true);
  expect(filtered.tasks.map((t) => t.taskId)).toEqual(['t-b']);
});

test('tasks:get returns the task, or task:null when absent', async () => {
  await ledger.appendTaskStart(cwd, startRow('t-x'));
  const got = await invoke('tasks:get', { cwd, id: 't-x' });
  expect(got.ok).toBe(true);
  expect(got.task.taskId).toBe('t-x');
  expect(await invoke('tasks:get', { cwd, id: 'nope' })).toEqual({ ok: true, task: null });
});

test('tasks:get-switch reads the switch with changedAt + by', async () => {
  expect(await invoke('tasks:get-switch', { cwd })).toEqual({ ok: true, enabled: false, changedAt: null, by: null });
  const saved = taskSwitch.setTaskSwitch(cwd, true, { via: 'ui' });
  expect(await invoke('tasks:get-switch', { cwd })).toEqual({ ok: true, enabled: true, changedAt: saved.changedAt, by: { via: 'ui' } });
  const agentBy = { via: 'agent', claudeSessionId: 's-1', quote: 'turn it on', promptAt: '2026-11-23T10:00:00.000Z' };
  const saved2 = taskSwitch.setTaskSwitch(cwd, false, agentBy);
  expect(await invoke('tasks:get-switch', { cwd })).toEqual({ ok: true, enabled: false, changedAt: saved2.changedAt, by: agentBy });
});

test('tasks:get-switch reads a legacy entry without by as unknown', async () => {
  const { taskSwitchesPath } = require('../../scheduler/schedulerPaths.cjs');
  fs.writeFileSync(taskSwitchesPath(), JSON.stringify({ v: 1, projects: { [path.resolve(cwd)]: { enabled: true, changedAt: '2026-11-20T00:00:00.000Z' } } }));
  expect(await invoke('tasks:get-switch', { cwd })).toEqual({ ok: true, enabled: true, changedAt: '2026-11-20T00:00:00.000Z', by: { via: 'unknown' } });
});

test('tasks:set-switch writes, audits, and updates the reserve after every call', async () => {
  const on = await invoke('tasks:set-switch', { cwd, enabled: true });
  expect(on.ok).toBe(true);
  expect(on.enabled).toBe(true);
  expect(taskSwitch.isTaskSwitchOn(cwd)).toBe(true);
  expect(taskSwitch.getTaskSwitch(cwd).by).toEqual({ via: 'ui' });
  expect(auditSpy).toHaveBeenLastCalledWith('task_switch_changed', { cwd: path.resolve(cwd), enabled: true, via: 'ui' });
  expect(reserveSpy).toHaveBeenCalledTimes(2);
  expect(reserveSpy).toHaveBeenLastCalledWith(true);

  const off = await invoke('tasks:set-switch', { cwd, enabled: false });
  expect(off.enabled).toBe(false);
  expect(auditSpy).toHaveBeenLastCalledWith('task_switch_changed', { cwd: path.resolve(cwd), enabled: false, via: 'ui' });
  expect(auditSpy).toHaveBeenCalledTimes(2);
  expect(reserveSpy).toHaveBeenCalledTimes(3);
  expect(reserveSpy).toHaveBeenLastCalledWith(false);
});

test('invalid payloads are rejected before any write', async () => {
  expect(() => invoke('tasks:set-switch', { cwd, enabled: 'yes' })).toThrow();
  expect(() => invoke('tasks:set-switch', { cwd: 'relative/dir', enabled: true })).toThrow();
  expect(() => invoke('tasks:set-switch', { cwd, enabled: true, extra: 1 })).toThrow();
  expect(() => invoke('tasks:list', { cwd, limit: 500 })).toThrow();
  expect(() => invoke('tasks:list', { cwd, offset: -1 })).toThrow();
  expect(() => invoke('tasks:get', { cwd })).toThrow();
  expect(() => invoke('tasks:get-switch', {})).toThrow();
  expect(taskSwitch.anyTaskSwitchOn()).toBe(false);
  expect(auditSpy).not.toHaveBeenCalled();
  expect(reserveSpy).toHaveBeenCalledTimes(1);
});

test('set-switch is the only setTaskSwitch caller in src/main outside taskSwitch.cjs', () => {
  const root = path.resolve(__dirname, '../../../');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(c?js|ts)$/.test(e.name)) continue;
      if (/setTaskSwitch\s*\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  expect(hits.sort()).toEqual(['lib/tasks/taskIpc.cjs', 'lib/tasks/taskSwitch.cjs'].map((p) => p.split('/').join(path.sep)));
});
