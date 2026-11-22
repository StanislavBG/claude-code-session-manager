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
  sw.setTaskSwitch('/p/a', true);
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
  const onFile = JSON.parse(fs.readFileSync(taskSwitchesPath(), 'utf8'));
  expect(onFile.v).toBe(1);
  expect(onFile.projects['/p/a'].enabled).toBe(true);
  expect(typeof onFile.projects['/p/a'].changedAt).toBe('string');

  sw.setTaskSwitch('/p/a', false);
  expect(sw.isTaskSwitchOn('/p/a')).toBe(false);
  const list = sw.listTaskProjects();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ cwd: '/p/a', enabled: false });
  expect(Number.isNaN(Date.parse(list[0].changedAt))).toBe(false);
});

test('anyTaskSwitchOn tracks whether some project is on', () => {
  sw.setTaskSwitch('/p/a', true);
  sw.setTaskSwitch('/p/b', false);
  expect(sw.anyTaskSwitchOn()).toBe(true);
  sw.setTaskSwitch('/p/a', false);
  expect(sw.anyTaskSwitchOn()).toBe(false);
  expect(sw.listTaskProjects().map((p) => p.cwd).sort()).toEqual(['/p/a', '/p/b']);
});

test('corrupt file reads as all-off and never throws', () => {
  fs.writeFileSync(taskSwitchesPath(), '{not json');
  expect(sw.isTaskSwitchOn('/p/a')).toBe(false);
  expect(sw.anyTaskSwitchOn()).toBe(false);
  expect(sw.listTaskProjects()).toEqual([]);
  // A write over a corrupt file recovers it.
  sw.setTaskSwitch('/p/a', true);
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
});

test('external file change is picked up via mtime', () => {
  sw.setTaskSwitch('/p/a', true);
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
  const file = taskSwitchesPath();
  fs.writeFileSync(file, JSON.stringify({ v: 1, projects: { '/p/a': { enabled: false, changedAt: 'x' } } }));
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(file, future, future);
  expect(sw.isTaskSwitchOn('/p/a')).toBe(false);
});

test('trailing-slash and relative cwd spellings normalize with path.resolve', () => {
  sw.setTaskSwitch('/p/a/', true);
  expect(sw.isTaskSwitchOn('/p/a')).toBe(true);
  expect(sw.isTaskSwitchOn('/p/x/../a')).toBe(true);
  expect(sw.listTaskProjects().map((p) => p.cwd)).toEqual(['/p/a']);
});
