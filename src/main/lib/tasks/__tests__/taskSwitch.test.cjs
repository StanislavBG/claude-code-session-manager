/**
 * taskSwitch.test.cjs — the machine-level 'Scripts may run Tasks' switch store
 * (lib/tasks/taskSwitch.cjs) over a tmp SM_SCHEDULER_HOME.
 *
 * Run: timeout 300 npx vitest run src/main/lib/tasks/__tests__/taskSwitch.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { taskSwitchesPath, sessionSlotsConfigPath } = require('../../scheduler/schedulerPaths.cjs');
const sw = require('../taskSwitch.cjs');

let home;
let prevHome;
beforeEach(() => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-taskswitch-'));
  process.env.SM_SCHEDULER_HOME = home;
  sw._resetForTests();
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('taskSwitchesPath sits beside sessionSlotsConfigPath under the home override', () => {
  expect(taskSwitchesPath()).toBe(path.join(home, 'task-switches.json'));
  expect(path.dirname(taskSwitchesPath())).toBe(path.dirname(sessionSlotsConfigPath()));
});

test('default is off with no file', () => {
  expect(sw.isTaskSwitchOn('/p/a')).toBe(false);
  expect(sw.anyTaskSwitchOn()).toBe(false);
  expect(sw.listTaskProjects()).toEqual([]);
});

test('on/off round trip; off keeps the entry', () => {
  sw.setTaskSwitch('/p/a', true, { via: 'ui' });
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
  const onFile = JSON.parse(fs.readFileSync(taskSwitchesPath(), 'utf8'));
  expect(onFile.v).toBe(1);
  expect(onFile.projects['/p/a'].enabled).toBe(true);
  expect(typeof onFile.projects['/p/a'].changedAt).toBe('string');

  sw.setTaskSwitch('/p/a', false, { via: 'ui' });
  expect(sw.isTaskSwitchOn('/p/a')).toBe(false);
  const list = sw.listTaskProjects();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ cwd: '/p/a', enabled: false });
  expect(Number.isNaN(Date.parse(list[0].changedAt))).toBe(false);
});

test('anyTaskSwitchOn tracks whether some project is on', () => {
  sw.setTaskSwitch('/p/a', true, { via: 'ui' });
  sw.setTaskSwitch('/p/b', false, { via: 'ui' });
  expect(sw.anyTaskSwitchOn()).toBe(true);
  sw.setTaskSwitch('/p/a', false, { via: 'ui' });
  expect(sw.anyTaskSwitchOn()).toBe(false);
  expect(sw.listTaskProjects().map((p) => p.cwd).sort()).toEqual(['/p/a', '/p/b']);
});

test('corrupt file reads as all-off and never throws', () => {
  fs.writeFileSync(taskSwitchesPath(), '{not json');
  expect(sw.isTaskSwitchOn('/p/a')).toBe(false);
  expect(sw.anyTaskSwitchOn()).toBe(false);
  expect(sw.listTaskProjects()).toEqual([]);
  // A write over a corrupt file recovers it.
  sw.setTaskSwitch('/p/a', true, { via: 'ui' });
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
});

test('external file change is picked up via mtime', () => {
  sw.setTaskSwitch('/p/a', true, { via: 'ui' });
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
  const file = taskSwitchesPath();
  fs.writeFileSync(file, JSON.stringify({ v: 1, projects: { '/p/a': { enabled: false, changedAt: 'x' } } }));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(file, future, future);
  expect(sw.isTaskSwitchOn('/p/a')).toBe(false);
});

test('trailing-slash and relative cwd spellings normalize with path.resolve', () => {
  sw.setTaskSwitch('/p/a/', true, { via: 'ui' });
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
  expect(sw.isTaskSwitchOn('/p/x/../a')).toBe(true);
  expect(sw.listTaskProjects().map((p) => p.cwd)).toEqual(['/p/a']);
});

const UI = { via: 'ui' };
const AGENT = { via: 'agent', claudeSessionId: 'sess-1', quote: 'yes, turn Tasks on', promptAt: '2026-11-23T10:00:00.000Z' };

test('every invalid by is refused and leaves the file byte-for-byte unchanged', () => {
  sw.setTaskSwitch('/p/a', true, UI);
  const before = fs.readFileSync(taskSwitchesPath());
  const bad = [
    undefined, null, 'ui', 42, [], {}, { via: 'unknown' }, { via: 'script' },
    { via: 'ui', extra: 1 },
    { via: 'agent' },
    { ...AGENT, claudeSessionId: '' },
    { ...AGENT, claudeSessionId: 'x'.repeat(129) },
    { ...AGENT, claudeSessionId: 7 },
    { ...AGENT, quote: '' },
    { ...AGENT, quote: 'q'.repeat(2001) },
    { ...AGENT, promptAt: 'not a date' },
    { ...AGENT, promptAt: 123 },
    { via: 'agent', quote: 'q', promptAt: AGENT.promptAt },
  ];
  for (const by of bad) {
    expect(() => sw.setTaskSwitch('/p/b', true, by)).toThrow(/by must be/);
  }
  expect(() => sw.setTaskSwitch('/p/b', true)).toThrow(/by must be/);
  expect(fs.readFileSync(taskSwitchesPath()).equals(before)).toBe(true);
  expect(sw.isTaskSwitchOn('/p/b')).toBe(false);
});

test('missing by on a fresh home creates no file', () => {
  expect(() => sw.setTaskSwitch('/p/a', true)).toThrow();
  expect(fs.existsSync(taskSwitchesPath())).toBe(false);
});

test('ui and agent round trips through getTaskSwitch', () => {
  const saved = sw.setTaskSwitch('/p/a', true, UI);
  expect(saved).toMatchObject({ cwd: '/p/a', enabled: true, by: { via: 'ui' } });
  expect(sw.getTaskSwitch('/p/a')).toEqual({ cwd: '/p/a', enabled: true, changedAt: saved.changedAt, by: { via: 'ui' } });

  sw.setTaskSwitch('/p/b', false, { ...AGENT, junk: 'dropped' });
  const got = sw.getTaskSwitch('/p/b');
  expect(got.enabled).toBe(false);
  expect(got.by).toEqual(AGENT);
  const onDisk = JSON.parse(fs.readFileSync(taskSwitchesPath(), 'utf8')).projects['/p/b'];
  expect(onDisk.by).toEqual(AGENT);
  expect(sw.listTaskProjects().find((r) => r.cwd === '/p/b').by).toEqual(AGENT);
  expect(sw.listTaskProjects().find((r) => r.cwd === '/p/a').by).toEqual(UI);
});

test('getTaskSwitch: no entry, bad cwd, never throws', () => {
  expect(sw.getTaskSwitch('/p/none')).toEqual({ cwd: '/p/none', enabled: false, changedAt: null, by: null });
  expect(sw.getTaskSwitch('')).toBeNull();
  expect(sw.getTaskSwitch(42)).toBeNull();
  expect(sw.getTaskSwitch(undefined)).toBeNull();
  fs.writeFileSync(taskSwitchesPath(), '{not json');
  expect(sw.getTaskSwitch('/p/a')).toEqual({ cwd: '/p/a', enabled: false, changedAt: null, by: null });
});

test('a hand-written legacy entry without by reads as unknown, enabled kept, file not rewritten', () => {
  const file = taskSwitchesPath();
  const raw = JSON.stringify({ v: 1, projects: { '/p/legacy': { enabled: true, changedAt: '2026-11-20T00:00:00.000Z' } } });
  fs.writeFileSync(file, raw);
  expect(sw.getTaskSwitch('/p/legacy')).toEqual({ cwd: '/p/legacy', enabled: true, changedAt: '2026-11-20T00:00:00.000Z', by: { via: 'unknown' } });
  expect(sw.isTaskSwitchOn('/p/legacy')).toBe(true);
  expect(sw.listTaskProjects()[0].by).toEqual({ via: 'unknown' });
  expect(fs.readFileSync(file, 'utf8')).toBe(raw);
});

test('a malformed stored by reads as unknown while enabled is kept', () => {
  const file = taskSwitchesPath();
  fs.writeFileSync(file, JSON.stringify({ v: 1, projects: {
    '/p/a': { enabled: true, changedAt: 'x', by: { via: 'agent', claudeSessionId: '' } },
    '/p/b': { enabled: true, changedAt: 'x', by: 'ui' },
    '/p/c': { enabled: false, changedAt: 'x', by: { via: 'unknown' } },
  } }));
  for (const cwd of ['/p/a', '/p/b']) {
    expect(sw.getTaskSwitch(cwd)).toMatchObject({ enabled: true, by: { via: 'unknown' } });
  }
  expect(sw.getTaskSwitch('/p/c')).toMatchObject({ enabled: false, by: { via: 'unknown' } });
});

test('syncInteractiveReserve drives sessionSlots.setInteractiveReserve and never throws', async () => {
  const { vi } = await import('vitest');
  const sessionSlots = require('../../scheduler/sessionSlots.cjs');
  const spy = vi.spyOn(sessionSlots, 'setInteractiveReserve').mockImplementation((on) => !!on);
  try {
    expect(sw.syncInteractiveReserve()).toBe(false);
    expect(spy).toHaveBeenLastCalledWith(false);
    sw.setTaskSwitch('/p/a', true, UI);
    expect(sw.syncInteractiveReserve()).toBe(true);
    expect(spy).toHaveBeenLastCalledWith(true);
    spy.mockImplementation(() => { throw new Error('boom'); });
    expect(sw.syncInteractiveReserve()).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test('taskSwitch.cjs does not load the slot pool at require time', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'taskSwitch.cjs'), 'utf8');
  const topLevelRequires = src.split('\n').filter((l) => /^const .*require\(/.test(l));
  expect(topLevelRequires.some((l) => /sessionSlots/.test(l))).toBe(false);
});
