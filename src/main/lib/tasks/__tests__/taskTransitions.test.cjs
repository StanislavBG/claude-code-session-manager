/**
 * taskTransitions.test.cjs — TASK_LEGAL_TRANSITIONS + transitionTask in
 * lib/tasks/taskLedger.cjs: legal edges, refused edges (throw under test,
 * audit in prod), {domain}.{action} line kinds with from/to, and the
 * timeout-derived 'interrupted' status going through the table.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskTransitions.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledger = require('../taskLedger.cjs');
const auditLog = require('../../telemetry/auditLog.cjs');
const { opsPath } = require('../../opsOwnership.cjs');

let cwd;
let home;
beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-task-tr-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-task-tr-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  ledger._resetForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function linesOf(startedAt) {
  const day = opsPath(cwd, 'tasks', `${localDate(startedAt)}.jsonl`);
  return fs.readFileSync(day, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

const start = (taskId, over = {}) => ({
  taskId, cwd, agent: 'dev-lead', model: 'claude-sonnet-4-5', startedAt: new Date().toISOString(),
  timeoutSec: 60, prompt: 'p', ...over,
});

test('legal edges: null → running, running → every terminal status, null → terminal (import)', () => {
  const T = ledger.TASK_LEGAL_TRANSITIONS;
  expect(ledger.transitionTask(null, 'running')).toBe(true);
  for (const s of ledger.TERMINAL_STATUSES) {
    expect(T.running).toContain(s);
    expect(ledger.transitionTask('running', s)).toBe(true);
    expect(ledger.transitionTask(null, s)).toBe(true);
    expect(T[s]).toEqual([]);
  }
  expect(T.running).toContain('interrupted');
});

test('illegal edges throw under test: terminal → anything, running → running, unknown status', () => {
  expect(() => ledger.transitionTask('ok', 'running', { taskId: 't' })).toThrow(/illegal task transition ok -> running/);
  expect(() => ledger.transitionTask('ok', 'error')).toThrow(/illegal/);
  expect(() => ledger.transitionTask('running', 'running')).toThrow(/illegal/);
  expect(() => ledger.transitionTask('running', 'bogus')).toThrow(/illegal/);
  expect(() => ledger.transitionTask('bogus', 'ok')).toThrow(/illegal/);
});

test('in prod an illegal edge is refused and audited, never thrown', () => {
  vi.stubEnv('VITEST', '');
  const audit = vi.spyOn(auditLog, 'appendAuditEvent').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(ledger.transitionTask('ok', 'error', { taskId: 't9', source: 'test' })).toBe(false);
  expect(ledger.getRefusedTransitionCount()).toBe(1);
  expect(audit).toHaveBeenCalledWith('task_transition_refused', expect.objectContaining({
    taskId: 't9', from: 'ok', to: 'error', source: 'test',
  }));
});

test('start + end lines carry task.started / task.status_changed with from/to', async () => {
  const s = start('a1');
  await ledger.appendTaskStart(cwd, s);
  await ledger.appendTaskEnd(cwd, { taskId: 'a1', startedAt: s.startedAt, status: 'error', output: 'o' });
  await ledger.appendImported(cwd, { ...start('a2'), status: 'ok', importId: 'imp-a2', output: 'o' });
  const lines = linesOf(s.startedAt);
  expect(lines[0]).toMatchObject({ kind: 'task.started', from: null, to: 'running' });
  expect(lines[1]).toMatchObject({ kind: 'task.status_changed', from: 'running', to: 'error', status: 'error' });
  expect(lines[2]).toMatchObject({ kind: 'task.status_changed', from: null, to: 'ok', importId: 'imp-a2' });
  const { tasks } = await ledger.listTasks(cwd);
  expect(Object.fromEntries(tasks.map((t) => [t.taskId, t.status]))).toEqual({ a1: 'error', a2: 'ok' });
  expect(tasks[0]).not.toHaveProperty('from');
  expect(await ledger.hasImport(cwd, 'imp-a2')).toBe(true);
});

test('a second end is an illegal ok → error edge: throws under test, refused (no line) in prod', async () => {
  const s = start('b1');
  await ledger.appendTaskStart(cwd, s);
  await ledger.appendTaskEnd(cwd, { taskId: 'b1', startedAt: s.startedAt, status: 'ok' });
  await expect(ledger.appendTaskEnd(cwd, { taskId: 'b1', startedAt: s.startedAt, status: 'error' }))
    .rejects.toThrow(/illegal task transition ok -> error/);

  vi.stubEnv('VITEST', '');
  const audit = vi.spyOn(auditLog, 'appendAuditEvent').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await ledger.appendTaskEnd(cwd, { taskId: 'b1', startedAt: s.startedAt, status: 'error' })).toBeNull();
  expect(audit).toHaveBeenCalledWith('task_transition_refused', expect.objectContaining({ taskId: 'b1', from: 'ok', to: 'error' }));
  expect(linesOf(s.startedAt).map((l) => l.kind)).toEqual(['task.started', 'task.status_changed']);
  expect((await ledger.getTask(cwd, 'b1')).status).toBe('ok');
});

test('timeout-derived interrupted goes through the table', async () => {
  const s = start('c1', { startedAt: new Date(Date.now() - 3600000).toISOString(), timeoutSec: 60 });
  await ledger.appendTaskStart(cwd, s);
  expect((await ledger.listTasks(cwd)).tasks[0].status).toBe('interrupted');
  // Within its window it is still running.
  expect((await ledger.listTasks(cwd, { now: Date.parse(s.startedAt) + 1000 })).tasks[0].status).toBe('running');

  // Remove the running → interrupted edge: the derivation now hits the table's refusal.
  const edges = ledger.TASK_LEGAL_TRANSITIONS.running;
  const idx = edges.indexOf('interrupted');
  edges.splice(idx, 1);
  try {
    await expect(ledger.listTasks(cwd)).rejects.toThrow(/illegal task transition running -> interrupted/);
    vi.stubEnv('VITEST', '');
    const audit = vi.spyOn(auditLog, 'appendAuditEvent').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await ledger.listTasks(cwd)).tasks[0].status).toBe('running');
    expect(audit).toHaveBeenCalledWith('task_transition_refused', expect.objectContaining({
      taskId: 'c1', from: 'running', to: 'interrupted', source: 'foldedStatus:timeout',
    }));
  } finally {
    edges.splice(idx, 0, 'interrupted');
  }
});

test('legacy start/end/imported lines on disk still read', async () => {
  const startedAt = new Date().toISOString();
  const day = opsPath(cwd, 'tasks', `${localDate(startedAt)}.jsonl`);
  fs.mkdirSync(path.dirname(day), { recursive: true });
  fs.writeFileSync(day, [
    { v: 1, kind: 'start', taskId: 'l1', startedAt, sessionId: 's-l1', persisted: true },
    { v: 1, kind: 'end', taskId: 'l1', startedAt, status: 'ok' },
    { v: 1, kind: 'imported', taskId: 'l2', startedAt, status: 'error', importId: 'imp-l2', sessionId: 's-l2', persisted: true },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const { tasks, skippedLines } = await ledger.listTasks(cwd);
  expect(skippedLines).toBe(0);
  expect(Object.fromEntries(tasks.map((t) => [t.taskId, t.status]))).toEqual({ l1: 'ok', l2: 'error' });
  expect(await ledger.hasImport(cwd, 'imp-l2')).toBe(true);
  expect([...(await ledger.listPersistedSessionIds(cwd))].sort()).toEqual(['s-l1', 's-l2']);
});
