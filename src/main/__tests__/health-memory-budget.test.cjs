/**
 * health-memory-budget.test.cjs — per-project auto-memory index (MEMORY.md)
 * budget check in health.cjs: under / at / over budget, configurable budget,
 * and resolution through memoryDirResolve.cjs (default + autoMemoryDirectory).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-memory-budget.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MEMORY_BUDGET_DEFAULTS,
  resolveMemoryBudget,
  measureProjectMemory,
  evaluateMemoryBudget,
} = require('../health.cjs');
const { encodeCwd } = require('../lib/util/encodeCwd.cjs');

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-budget-'));
  dirs.push(d);
  return d;
}

function index(lines, lineLen = 10) {
  return Array.from({ length: lines }, () => 'x'.repeat(lineLen - 1)).join('\n') + '\n';
}

/** Write MEMORY.md at the default native location for `cwd` under `home`. */
function writeDefaultIndex(home, cwd, text) {
  const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd), 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), text);
  return dir;
}

function measure(home, cwd, settings = {}) {
  return measureProjectMemory(cwd, { home, repoRoot: cwd, settings });
}

test('defaults are 25 KB / 200 lines', () => {
  expect(MEMORY_BUDGET_DEFAULTS).toEqual({ maxBytes: 25600, maxLines: 200 });
  expect(resolveMemoryBudget(undefined, {})).toEqual({ maxBytes: 25600, maxLines: 200 });
});

test('under budget: ok, sizes reported', () => {
  const home = tmp();
  const cwd = '/work/under';
  writeDefaultIndex(home, cwd, index(50));
  const m = measure(home, cwd);
  expect(m).toMatchObject({ cwd, bytes: 500, lines: 50 });
  const { component, issues } = evaluateMemoryBudget([m]);
  expect(component.ok).toBe(true);
  expect(component.overBudget).toEqual([]);
  expect(component.projects).toEqual([{ cwd, bytes: 500, lines: 50, overBudget: false }]);
  expect(issues).toEqual([]);
});

test('exactly at budget (200 lines, 25600 bytes): ok', () => {
  const home = tmp();
  const cwd = '/work/at';
  writeDefaultIndex(home, cwd, index(200, 128));
  const m = measure(home, cwd);
  expect(m.lines).toBe(200);
  expect(m.bytes).toBe(25600);
  const { component, issues } = evaluateMemoryBudget([m]);
  expect(component.ok).toBe(true);
  expect(issues).toEqual([]);
});

test('over budget by lines: flagged non-GREEN with sizes', () => {
  const home = tmp();
  const cwd = '/work/over-lines';
  const dir = writeDefaultIndex(home, cwd, index(201));
  const { component, issues } = evaluateMemoryBudget([measure(home, cwd)]);
  expect(component.ok).toBe(false);
  expect(component.overBudget).toEqual([{ cwd, dir, bytes: 2010, lines: 201 }]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain(cwd);
  expect(issues[0]).toContain('2010 bytes');
  expect(issues[0]).toContain('201 lines');
  expect(issues[0]).toContain('25600');
});

test('over budget by bytes only: flagged', () => {
  const home = tmp();
  const cwd = '/work/over-bytes';
  writeDefaultIndex(home, cwd, index(10, 2600)); // 26000 bytes, 10 lines
  const { component } = evaluateMemoryBudget([measure(home, cwd)]);
  expect(component.ok).toBe(false);
  expect(component.overBudget[0]).toMatchObject({ bytes: 26000, lines: 10 });
});

test('mixed projects: only the over-budget one is flagged; shared dirs counted once', () => {
  const home = tmp();
  writeDefaultIndex(home, '/a', index(10));
  writeDefaultIndex(home, '/b', index(300));
  const a = measure(home, '/a');
  const b = measure(home, '/b');
  const { component, issues } = evaluateMemoryBudget([a, b, { ...b, cwd: '/b-worktree' }]);
  expect(component.ok).toBe(false);
  expect(component.checked).toBe(2);
  expect(component.overBudget.map((p) => p.cwd)).toEqual(['/b']);
  expect(issues).toHaveLength(1);
});

test('budget is configurable (override beats env beats default)', () => {
  expect(resolveMemoryBudget({}, { SM_MEMORY_BUDGET_BYTES: '1000', SM_MEMORY_BUDGET_LINES: '20' }))
    .toEqual({ maxBytes: 1000, maxLines: 20 });
  expect(resolveMemoryBudget({ maxLines: 5 }, { SM_MEMORY_BUDGET_LINES: '20' }))
    .toEqual({ maxBytes: 25600, maxLines: 5 });
  expect(resolveMemoryBudget({ maxBytes: -1 }, { SM_MEMORY_BUDGET_BYTES: 'junk' }).maxBytes).toBe(25600);
  const m = { cwd: '/c', dir: '/c/memory', bytes: 500, lines: 50 };
  expect(evaluateMemoryBudget([m], { maxBytes: 500, maxLines: 50 }).component.ok).toBe(true);
  expect(evaluateMemoryBudget([m], { maxBytes: 499, maxLines: 50 }).component.ok).toBe(false);
  expect(evaluateMemoryBudget([m], { maxBytes: 500, maxLines: 49 }).component.ok).toBe(false);
});

test('resolves autoMemoryDirectory override via memoryDirResolve', () => {
  const home = tmp();
  const custom = path.join(home, 'custom-mem');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'MEMORY.md'), index(3));
  const m = measure(home, '/proj', { user: { autoMemoryDirectory: custom } });
  expect(m).toMatchObject({ dir: custom, lines: 3, bytes: 30 });
});

test('no MEMORY.md or auto-memory disabled: not measured', () => {
  const home = tmp();
  expect(measure(home, '/missing')).toBeNull();
  writeDefaultIndex(home, '/off', index(500));
  expect(measure(home, '/off', { user: { autoMemoryEnabled: false } })).toBeNull();
  expect(evaluateMemoryBudget([]).component).toMatchObject({ ok: true, checked: 0 });
});
