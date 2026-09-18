// schedulerRuntimeState.cjs + quietMachineLease.cjs — fail-closed expiry.
const assert = require('node:assert');
const state = require('../schedulerRuntimeState.cjs');
const lease = require('../quietMachineLease.cjs');

const NOW = 10_000_000;
const GRACE = 10 * 60 * 1000;

beforeEach(() => { state.__resetForTests(); lease.__resetForTests(); });
afterEach(() => { state.__resetForTests(); lease.__resetForTests(); });

test('lease: expires only when holder not running AND past grace', () => {
  lease.acquire('q', { claimedAt: NOW - GRACE - 1 });
  assert.equal(lease.expireDead({ liveSlugs: new Set(['q']), now: NOW, graceMs: GRACE }), false, 'running row keeps it');
  assert.equal(lease.isHeld(), true);
  assert.equal(lease.expireDead({ liveSlugs: new Set(), now: NOW, graceMs: GRACE }), true);
  assert.equal(lease.isHeld(), false);
});

test('lease: inside the grace window or claimed after the pass began is kept', () => {
  lease.acquire('q', { claimedAt: NOW - 1000 });
  assert.equal(lease.expireDead({ liveSlugs: new Set(), now: NOW, graceMs: GRACE }), false);
  lease.release('q');
  lease.acquire('q', { claimedAt: NOW + 10 });
  assert.equal(lease.expireDead({ liveSlugs: new Set(), now: NOW, graceMs: GRACE }), false);
  assert.equal(lease.isHeld(), true);
});

test('investigations: set semantics, no double reservation, idempotent release', () => {
  assert.equal(state.reserveInvestigation('a'), true);
  assert.equal(state.reserveInvestigation('a'), false);
  assert.equal(state.investigationCount(), 1);
  assert.equal(state.releaseInvestigation('a'), true);
  assert.equal(state.releaseInvestigation('a'), false);
  assert.equal(state.investigationCount(), 0);
});

test('investigations: dead stamped pid with no investigating row expires; live pid/row survives', () => {
  state.reserveInvestigation('dead', { claimedAt: NOW - 1000 });
  state.stampInvestigationPid('dead', 111);
  state.reserveInvestigation('alive', { claimedAt: NOW - 1000 });
  state.stampInvestigationPid('alive', 222);
  state.reserveInvestigation('rowlive', { claimedAt: NOW - 2 * GRACE });
  const out = state.expireDeadInvestigations({
    liveSlugs: new Set(['rowlive']), pidAlive: (p) => p === 222, now: NOW, graceMs: GRACE,
  });
  assert.deepEqual(out, ['dead']);
  assert.equal(state.investigationCount(), 2);
});

test('investigations: pidless reservation expires past grace only', () => {
  state.reserveInvestigation('old', { claimedAt: NOW - GRACE - 1 });
  state.reserveInvestigation('fresh', { claimedAt: NOW - 1000 });
  const out = state.expireDeadInvestigations({ liveSlugs: new Set(), pidAlive: () => false, now: NOW, graceMs: GRACE });
  assert.deepEqual(out, ['old']);
});
