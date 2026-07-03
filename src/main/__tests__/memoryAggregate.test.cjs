'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClusters } = require('../memoryAggregate.cjs');

test('parseClusters maps well-formed JSON to the result shape and routes unlisted slugs to orphans', () => {
  const slugs = ['scheduler_concurrency_memory', 'no_schedule_self_e2e', 'unrelated_note'];
  const raw = JSON.stringify({
    clusters: [
      {
        name: 'Scheduler ops',
        summary: 'Scheduler concurrency + e2e isolation rules.',
        memberSlugs: ['scheduler_concurrency_memory', 'no_schedule_self_e2e'],
        links: [{ from: 'scheduler_concurrency_memory', to: 'no_schedule_self_e2e', label: 'related' }],
      },
    ],
    orphans: ['unrelated_note'],
  });

  const result = parseClusters(raw, slugs);

  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0].name, 'Scheduler ops');
  assert.deepEqual(result.clusters[0].memberSlugs, ['scheduler_concurrency_memory', 'no_schedule_self_e2e']);
  assert.deepEqual(result.clusters[0].links, [{ from: 'scheduler_concurrency_memory', to: 'no_schedule_self_e2e', label: 'related' }]);
  assert.deepEqual(result.orphans, ['unrelated_note']);
});

test('parseClusters routes a slug omitted from the response to orphans even without explicit listing', () => {
  const slugs = ['a', 'b', 'c'];
  const raw = JSON.stringify({
    clusters: [{ name: 'Cluster A', summary: 's', memberSlugs: ['a'], links: [] }],
  });

  const result = parseClusters(raw, slugs);

  assert.deepEqual(result.orphans.sort(), ['b', 'c']);
});

test('parseClusters returns empty clusters and all slugs as orphans on garbage LLM output', () => {
  const slugs = ['one', 'two', 'three'];
  const result = parseClusters('not json at all, just prose garbage', slugs);

  assert.deepEqual(result.clusters, []);
  assert.deepEqual(result.orphans, slugs);
});

test('parseClusters is robust to empty/null input', () => {
  const slugs = ['x'];
  assert.deepEqual(parseClusters('', slugs), { clusters: [], orphans: ['x'] });
  assert.deepEqual(parseClusters(null, slugs), { clusters: [], orphans: ['x'] });
});

test('parseClusters drops link endpoints and members that reference nonexistent slugs', () => {
  const slugs = ['known'];
  const raw = JSON.stringify({
    clusters: [{
      name: 'C',
      summary: 's',
      memberSlugs: ['known', 'ghost'],
      links: [{ from: 'known', to: 'ghost' }],
    }],
  });

  const result = parseClusters(raw, slugs);
  assert.deepEqual(result.clusters[0].memberSlugs, ['known']);
  assert.deepEqual(result.clusters[0].links, []);
  assert.deepEqual(result.orphans, []);
});
