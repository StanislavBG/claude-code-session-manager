'use strict';
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { describeStarveHold } = require('../scheduler/starvation.cjs');

const pend = (slug, extra = {}) => ({ slug, status: 'pending', cwd: '/p', ...extra });

test('memory-deferred from the last tick', () => {
  assert.equal(describeStarveHold({ projectRows: [pend('a')], lastTick: { fired: false, reason: 'memory-deferred' } }), 'memory-deferred');
});
test('memory-deferred carried past a fired tick', () => {
  assert.equal(describeStarveHold({
    projectRows: [pend('a')], lastTick: { fired: true }, lastHoldTick: { fired: false, reason: 'memory-deferred' },
  }), 'memory-deferred');
});
test('dependency-blocked on a needs_review dep; aged-out completed dep does not block', () => {
  const rows = [pend('a', { dependsOn: ['b'] }), { slug: 'b', status: 'needs_review', cwd: '/p' }];
  assert.equal(describeStarveHold({ projectRows: rows, lastTick: { fired: false, reason: 'slots-exhausted' } }), 'dependency-blocked');
  const aged = [pend('a', { dependsOn: ['gone'] })];
  assert.equal(describeStarveHold({ projectRows: aged, lastTick: { fired: false, reason: 'slots-exhausted' } }), 'slots-exhausted');
  const done = [pend('a', { dependsOn: ['b'] }), { slug: 'b', status: 'completed', cwd: '/p' }];
  assert.notEqual(describeStarveHold({ projectRows: done, lastTick: { fired: true } }), 'dependency-blocked');
});
test('launch-blocked', () => {
  const rows = [pend('a')];
  const launchFailure = require('../lib/scheduler/launchFailure.cjs');
  const launchBlocks = { [launchFailure.launchBlockKeyFor(rows[0])]: { at: 1 } };
  assert.equal(describeStarveHold({ projectRows: rows, launchBlocks, lastTick: { fired: true } }), 'launch-blocked');
});
test('dispatching-elsewhere when fired and no carried hold', () => {
  assert.equal(describeStarveHold({ projectRows: [pend('a')], lastTick: { fired: true }, lastHoldTick: null }), 'dispatching-elsewhere');
});
test('unknown only when lastTick is null', () => {
  assert.equal(describeStarveHold({ projectRows: [pend('a')], lastTick: null }), 'unknown');
});
