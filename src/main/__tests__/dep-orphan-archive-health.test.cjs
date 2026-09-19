/**
 * PRD 1286 — archiving a row must never orphan its dependents, and a fully
 * blocked queue must never read healthy.
 *
 * Option (b): the depends-gate (computeDepHistorySatisfaction) treats a dep
 * whose PRD file was archived — including the manual-archive layout
 * prds-archived/<ISO-ts>/<slug>.md — as satisfied. A dep with no row, no
 * history and no archived file still HOLDS.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/dep-orphan-archive-health.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-1286-home-'));
process.env.HOME = tmpHome;

const scheduler = require('../scheduler.cjs');
const { pickNextBatch } = require('../lib/schedulerBatch.cjs');
const { evaluateUnresolvableDepHealth } = require('../health.cjs');

function projectWithDependent(dep) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-1286-proj-'));
  const jobs = [{ slug: '902-next', status: 'pending', cwd, dependsOn: [dep] }];
  return { cwd, jobs };
}

async function eligible(jobs) {
  const satisfiedSlugsByCwd = await scheduler.computeDepHistorySatisfaction({ jobs });
  const { batch: picked } = pickNextBatch(jobs, new Set(), 3, { satisfiedSlugsByCwd });
  return { batch: picked.map((j) => j.slug ?? j.job?.slug ?? j), satisfiedSlugsByCwd };
}

test('a dep archived via the manual-archive layout (prds-archived/<ts>/) leaves its dependent eligible', async () => {
  const { cwd, jobs } = projectWithDependent('fo-01-base'); // bare slug, as authored
  const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'e1', 'prds-archived', '2026-09-18T01-00-00-000Z');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '900-fo-01-base.md'), '# Goal\n');
  const { batch } = await eligible(jobs);
  expect(batch).toContain('902-next');
});

test('a dep that never ran (no row, history or archived file) keeps its dependent held', async () => {
  const { jobs } = projectWithDependent('fo-01-base');
  const { batch } = await eligible(jobs);
  expect(batch).not.toContain('902-next');
});

test('health: every pending row held behind one unresolvable root is non-GREEN and names the root', async () => {
  const { cwd } = projectWithDependent('fo-01-base');
  const jobs = [
    { slug: '902-a', status: 'pending', cwd, dependsOn: ['fo-01-base'] },
    { slug: '903-b', status: 'pending', cwd, dependsOn: ['a'] }, // transitive, bare
  ];
  const satisfied = await scheduler.computeDepHistorySatisfaction({ jobs });
  const res = evaluateUnresolvableDepHealth(jobs, satisfied);
  expect(res.ok).toBe(false);
  expect(res.projects[0].roots).toEqual(['fo-01-base']);
  expect(res.message).toContain('fo-01-base');
});

test('health: a project with any dispatchable pending row, or a satisfied root, stays GREEN', async () => {
  const { cwd } = projectWithDependent('x');
  const mixed = [
    { slug: '902-a', status: 'pending', cwd, dependsOn: ['fo-01-base'] },
    { slug: '903-free', status: 'pending', cwd, dependsOn: [] },
  ];
  const satisfied = await scheduler.computeDepHistorySatisfaction({ jobs: mixed });
  expect(evaluateUnresolvableDepHealth(mixed, satisfied).ok).toBe(true);
  const satisfiedRoot = new Map([[cwd, new Set(['900-fo-01-base'])]]);
  expect(evaluateUnresolvableDepHealth([mixed[0]], satisfiedRoot).ok).toBe(true);
});
