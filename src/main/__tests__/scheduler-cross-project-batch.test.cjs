'use strict';

// Ported from the retired top-level test-root directory (a node:test suite,
// never runnable by this repo's vitest-only setup — see CLAUDE.md's Commands
// section). Pins the two basic cross-project pickNextBatch contracts that
// were asserted there but not literally exercised elsewhere: N independent
// projects each with a single pending job all fire together when the global
// slot pool is generous, and a global cap BELOW the total pending count
// across projects admits exactly that many, not more.
//
// Run: timeout 120 npx vitest run src/main/__tests__/scheduler-cross-project-batch.test.cjs

const assert = require('node:assert/strict');
const { pickNextBatch } = require('../lib/schedulerBatch.cjs');

function job(slug, status, cwd, parallelGroup) {
  return { slug, status, cwd, parallelGroup, dependsOn: [] };
}

test('3 independent projects, 1 pending each, generous cap (6) → all 3 fire', () => {
  const jobs = [
    job('a-job', 'pending', '/a', 5),
    job('b-job', 'pending', '/b', 5),
    job('c-job', 'pending', '/c', 5),
  ];
  const { batch, reason } = pickNextBatch(jobs, new Set(), 6);
  assert.equal(batch.length, 3);
  assert.equal(reason, null);
  const slugs = new Set(batch.map((j) => j.slug));
  assert.ok(slugs.has('a-job'));
  assert.ok(slugs.has('b-job'));
  assert.ok(slugs.has('c-job'));
});

test('3 independent projects, 1 pending each, cap 2 (below total pending) → exactly 2 fire', () => {
  const jobs = [
    job('a-job', 'pending', '/a', 5),
    job('b-job', 'pending', '/b', 5),
    job('c-job', 'pending', '/c', 5),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 2);
  assert.equal(batch.length, 2);
});
