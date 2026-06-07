/**
 * Unit tests for pickNextBatch / pickForProject (lib/schedulerBatch.cjs).
 *
 * Run with: node --test test/scheduler-pickNextBatch.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickNextBatch, pickForProject } =
  require('../src/main/lib/schedulerBatch.cjs');

// Helper: build a minimal job object.
function job(slug, status, cwd, parallelGroup) {
  return { slug, status, cwd, parallelGroup };
}

// ─────────────────────────────────────────── cross-project parallelism

test('3 projects, 1 pending each, cap 6, nothing running → all 3 fire', () => {
  const jobs = [
    job('a-job', 'pending', '/a', 5),
    job('b-job', 'pending', '/b', 5),
    job('c-job', 'pending', '/c', 5),
  ];
  const batch = pickNextBatch(jobs, new Set(), 6);
  assert.equal(batch.length, 3);
  const slugs = new Set(batch.map((j) => j.slug));
  assert.ok(slugs.has('a-job'));
  assert.ok(slugs.has('b-job'));
  assert.ok(slugs.has('c-job'));
});

test('cap 2, 3 projects 1 pending each → exactly 2 fire', () => {
  const jobs = [
    job('a-job', 'pending', '/a', 5),
    job('b-job', 'pending', '/b', 5),
    job('c-job', 'pending', '/c', 5),
  ];
  const batch = pickNextBatch(jobs, new Set(), 2);
  assert.equal(batch.length, 2);
});

// ─────────────────────────────────────────── within-project group ordering

test('1 project, pending in groups 5 and 6, cap 6 → only group-5 fires', () => {
  const jobs = [
    job('a-g5', 'pending', '/a', 5),
    job('a-g6', 'pending', '/a', 6),
  ];
  const batch = pickNextBatch(jobs, new Set(), 6);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].slug, 'a-g5');
});

test('1 project, two pending in same group 5, cap 6 → both fire', () => {
  const jobs = [
    job('a-g5-x', 'pending', '/a', 5),
    job('a-g5-y', 'pending', '/a', 5),
  ];
  const batch = pickNextBatch(jobs, new Set(), 6);
  assert.equal(batch.length, 2);
  const slugs = new Set(batch.map((j) => j.slug));
  assert.ok(slugs.has('a-g5-x'));
  assert.ok(slugs.has('a-g5-y'));
});

// ─────────────────────────────────────────── failure gate

test('project /a: failed g5 blocks pending g6; project /b: fires anyway', () => {
  const jobs = [
    job('a-failed-g5', 'failed', '/a', 5),
    job('a-pending-g6', 'pending', '/a', 6),
    job('b-pending-g1', 'pending', '/b', 1),
  ];
  const batch = pickNextBatch(jobs, new Set(), 6);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].slug, 'b-pending-g1');
});

// ─────────────────────────────────────────── global cap with running jobs

test('global cap respected: 2 already running + 3 pending across 3 projects → only 1 more fires (cap 3)', () => {
  const jobs = [
    job('r1', 'running', '/a', 5),
    job('r2', 'running', '/b', 5),
    job('p-a', 'pending', '/a', 6),
    job('p-b', 'pending', '/b', 6),
    job('p-c', 'pending', '/c', 1),
  ];
  const running = new Set(['r1', 'r2']);
  const batch = pickNextBatch(jobs, running, 3);
  assert.equal(batch.length, 1);
});

// ─────────────────────────────────────────── pickForProject directly

test('pickForProject: failure gate holds project', () => {
  const pJobs = [
    job('failed', 'failed', '/x', 3),
    job('pending', 'pending', '/x', 5),
  ];
  const result = pickForProject(pJobs, new Set(), 10);
  assert.deepEqual(result, []);
});

test('pickForProject: backfills same group', () => {
  const pJobs = [
    job('running', 'running', '/x', 5),
    job('pending-1', 'pending', '/x', 5),
    job('pending-2', 'pending', '/x', 5),
  ];
  const running = new Set(['running']);
  const result = pickForProject(pJobs, running, 5);
  assert.equal(result.length, 2);
});

test('pickForProject: holds higher group while lower is running', () => {
  const pJobs = [
    job('running-g5', 'running', '/x', 5),
    job('pending-g6', 'pending', '/x', 6),
  ];
  const running = new Set(['running-g5']);
  const result = pickForProject(pJobs, running, 5);
  assert.deepEqual(result, []);
});
