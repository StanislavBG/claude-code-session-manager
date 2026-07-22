'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreMemories } = require('../lib/memoryStale.cjs');

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000; // fixed epoch ms for deterministic tests

test('a fresh linked memory is not stale', () => {
  const entries = [
    { name: 'a.md', mtimeMs: NOW - 5 * DAY_MS, body: 'links to [[b]]' },
    { name: 'b.md', mtimeMs: NOW - 5 * DAY_MS, body: 'nothing here' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  const b = result.find((r) => r.name === 'b.md');
  assert.equal(b.stale, false);
  assert.equal(b.inboundLinks, 1);
  assert.deepEqual(b.reasons, []);
});

test('a 200-day-old memory with zero inbound links is stale', () => {
  const entries = [
    { name: 'old.md', mtimeMs: NOW - 200 * DAY_MS, body: 'no links to me' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  const old = result[0];
  assert.equal(old.ageDays, 200);
  assert.equal(old.inboundLinks, 0);
  assert.equal(old.stale, true);
  assert.ok(old.reasons.some((r) => /90\+ days old/.test(r)));
});

test('a 200-day-old memory WITH an inbound link is not stale', () => {
  const entries = [
    { name: 'old.md', mtimeMs: NOW - 200 * DAY_MS, body: 'old content' },
    { name: 'linker.md', mtimeMs: NOW - 1 * DAY_MS, body: 'see [[old]] for context' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  const old = result.find((r) => r.name === 'old.md');
  assert.equal(old.inboundLinks, 1);
  assert.equal(old.stale, false);
});

test('a recent memory naming a dead path IS stale', () => {
  const entries = [
    { name: 'recent.md', mtimeMs: NOW - 1 * DAY_MS, body: 'see `src/main/gone.cjs` for details' },
  ];
  const existsPath = (p) => p !== 'src/main/gone.cjs';
  const result = scoreMemories({ entries, now: NOW, existsPath });
  const r = result[0];
  assert.equal(r.ageDays, 1);
  assert.deepEqual(r.deadRefs, ['src/main/gone.cjs']);
  assert.equal(r.stale, true);
  assert.ok(r.reasons.some((s) => /no longer exist/.test(s)));
});

test('a :42 line suffix is stripped before the existence check', () => {
  const entries = [
    { name: 'recent.md', mtimeMs: NOW - 1 * DAY_MS, body: 'see `src/main/config.cjs:42` for the helper' },
  ];
  let checked = null;
  const existsPath = (p) => { checked = p; return true; };
  const result = scoreMemories({ entries, now: NOW, existsPath });
  assert.equal(checked, 'src/main/config.cjs');
  assert.deepEqual(result[0].deadRefs, []);
  assert.equal(result[0].stale, false);
});

test('the candidate cap holds at 20', () => {
  const paths = Array.from({ length: 30 }, (_, i) => `src/main/file${i}.cjs`);
  const body = paths.map((p) => `\`${p}\``).join(' ');
  const entries = [{ name: 'many.md', mtimeMs: NOW - 1 * DAY_MS, body }];
  let callCount = 0;
  const existsPath = () => { callCount += 1; return false; };
  const result = scoreMemories({ entries, now: NOW, existsPath });
  assert.equal(result[0].deadRefs.length, 20);
  assert.equal(callCount, 20);
});

test('[[self]] in a memory own body does not count as an inbound link', () => {
  const entries = [
    { name: 'self.md', mtimeMs: NOW - 200 * DAY_MS, body: 'refers to itself: [[self]]' },
  ];
  const result = scoreMemories({ entries, now: NOW, existsPath: () => true });
  assert.equal(result[0].inboundLinks, 0);
  assert.equal(result[0].stale, true);
});
