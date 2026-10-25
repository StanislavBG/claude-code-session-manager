'use strict';
import { test, expect } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePersonaDefaultEstimate } = require('../lib/prd/prdAgentType.cjs');
const { computeJobBudgetMs } = require('../scheduler/budget.cjs');
const { AgentPersonaSaveSchema } = require('../lib/persona-macro/agentPersonaSchema.cjs');

function fixture(globalFm, projectFm) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pde-'));
  const globalDir = path.join(root, 'g');
  const projectDir = path.join(root, 'p');
  fs.mkdirSync(globalDir); fs.mkdirSync(projectDir);
  if (globalFm !== undefined) fs.writeFileSync(path.join(globalDir, 'art.md'), `---\nname: art\n${globalFm}\n---\nbody\n`);
  if (projectFm !== undefined) fs.writeFileSync(path.join(projectDir, 'art.md'), `---\nname: art\n${projectFm}\n---\n`);
  return { cwd: root, deps: { globalDir, projectDir } };
}

test('global persona default', () => {
  const f = fixture('defaultEstimateMinutes: 15');
  expect(resolvePersonaDefaultEstimate(f.cwd, 'art', f.deps)).toBe(15);
});

test('project overlay wins over global', () => {
  const f = fixture('defaultEstimateMinutes: 15', 'defaultEstimateMinutes: 30');
  expect(resolvePersonaDefaultEstimate(f.cwd, 'art', f.deps)).toBe(30);
});

test('malformed or out-of-range value returns null', () => {
  for (const v of ['abc', '0', '61', '1.5', '-3', '']) {
    const f = fixture(`defaultEstimateMinutes: ${v}`);
    expect(resolvePersonaDefaultEstimate(f.cwd, 'art', f.deps)).toBeNull();
  }
});

test('missing persona or key returns null', () => {
  const f = fixture(undefined);
  expect(resolvePersonaDefaultEstimate(f.cwd, 'art', f.deps)).toBeNull();
  const g = fixture('model: x');
  expect(resolvePersonaDefaultEstimate(g.cwd, 'art', g.deps)).toBeNull();
  expect(resolvePersonaDefaultEstimate(g.cwd, '../etc', g.deps)).toBeNull();
});

test('explicit estimate wins; persona default feeds the budget', () => {
  const f = fixture('defaultEstimateMinutes: 40');
  const persona = resolvePersonaDefaultEstimate(f.cwd, 'art', f.deps);
  expect(computeJobBudgetMs(10 ?? persona)).toBe(computeJobBudgetMs(10));
  expect(computeJobBudgetMs(undefined ?? persona)).toBe(computeJobBudgetMs(40));
  expect(computeJobBudgetMs(40)).toBeGreaterThan(computeJobBudgetMs(undefined));
});

test('schema accepts 1..60 integer only', () => {
  const base = { name: 'art', description: 'd', tools: [], model: 'm', color: 'c', tags: [], body: '' };
  expect(AgentPersonaSaveSchema.safeParse({ ...base, defaultEstimateMinutes: 15 }).success).toBe(true);
  expect(AgentPersonaSaveSchema.safeParse({ ...base, defaultEstimateMinutes: 61 }).success).toBe(false);
  expect(AgentPersonaSaveSchema.safeParse({ ...base, defaultEstimateMinutes: 1.5 }).success).toBe(false);
});
