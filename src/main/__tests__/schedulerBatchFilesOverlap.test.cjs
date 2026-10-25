'use strict';

// files-overlap mutual-exclusion hold (PRD 2220). Holds an eligible job while a
// running / earlier-picked job in the same project shares a path. No ordering.
//
// Run: timeout 120 npx vitest run src/main/__tests__/schedulerBatchFilesOverlap.test.cjs

const assert = require('node:assert/strict');
const { pickForProject, pickNextBatch, DEFAULT_PROJECT_CWD } = require('../lib/scheduler/schedulerBatch.cjs');

process.env.SM_PROJECT_JOB_CAP = '5'; // keep the per-project cap out of the way
const CWD = DEFAULT_PROJECT_CWD;
const job = (slug, status, files, extra = {}) => ({ slug, status, cwd: CWD, dependsOn: [], ...(files ? { files } : {}), ...extra });

test('equal paths: pending job is held behind a running job', () => {
  const jobs = [job('1-a', 'running', ['src/x.cjs']), job('2-b', 'pending', ['src/x.cjs'])];
  const { batch, holds } = pickForProject(jobs, new Set(['1-a']), 3);
  assert.deepEqual(batch, []);
  assert.equal(holds.find((h) => h.slug === '2-b').reason, 'files-overlap:1-a');
});

test('folder prefix overlaps in either direction', () => {
  let r = pickForProject([job('1-a', 'running', ['src/lib/']), job('2-b', 'pending', ['src/lib/y.cjs'])], new Set(['1-a']), 3);
  assert.deepEqual(r.batch, []);
  r = pickForProject([job('1-a', 'running', ['src/lib/y.cjs']), job('2-b', 'pending', ['src/lib/'])], new Set(['1-a']), 3);
  assert.deepEqual(r.batch, []);
});

test('no overlap (and folder name that merely shares a string prefix) fires', () => {
  const jobs = [job('1-a', 'running', ['src/lib/']), job('2-b', 'pending', ['src/library.cjs']), job('3-c', 'pending', ['docs/z.md'])];
  const { batch } = pickForProject(jobs, new Set(['1-a']), 3);
  assert.deepEqual(batch.map((j) => j.slug).sort(), ['2-b', '3-c']);
});

test('empty or missing files are never held', () => {
  const jobs = [job('1-a', 'running', ['src/x.cjs']), job('2-b', 'pending', []), job('3-c', 'pending')];
  const { batch } = pickForProject(jobs, new Set(['1-a']), 3);
  assert.deepEqual(batch.map((j) => j.slug).sort(), ['2-b', '3-c']);
});

test('job picked earlier in the same tick holds a later overlapping job (no order imposed)', () => {
  const jobs = [job('1-a', 'pending', ['src/x.cjs'], { parallelGroup: 1 }), job('2-b', 'pending', ['src/x.cjs'], { parallelGroup: 2 })];
  const { batch, holds } = pickForProject(jobs, new Set(), 3);
  assert.deepEqual(batch.map((j) => j.slug), ['1-a']);
  assert.equal(holds.find((h) => h.slug === '2-b').reason, 'files-overlap:1-a');
  const t = pickNextBatch(jobs, new Set(), 3);
  assert.deepEqual(t.batch.map((j) => j.slug), ['1-a']);
});

test('cross-project jobs never hold each other', () => {
  const jobs = [
    job('1-a', 'running', ['src/x.cjs'], { cwd: '/p/one' }),
    job('2-b', 'pending', ['src/x.cjs'], { cwd: '/p/two' }),
  ];
  const { batch } = pickNextBatch(jobs, new Set(['1-a']), 3);
  assert.deepEqual(batch.map((j) => j.slug), ['2-b']);
});

test('released on the first tick after the overlapping job leaves running', () => {
  const held = [job('1-a', 'running', ['src/x.cjs']), job('2-b', 'pending', ['src/x.cjs'])];
  assert.deepEqual(pickNextBatch(held, new Set(['1-a']), 3).batch, []);
  const after = [job('1-a', 'completed', ['src/x.cjs']), job('2-b', 'pending', ['src/x.cjs'])];
  assert.deepEqual(pickNextBatch(after, new Set(), 3).batch.map((j) => j.slug), ['2-b']);
});
