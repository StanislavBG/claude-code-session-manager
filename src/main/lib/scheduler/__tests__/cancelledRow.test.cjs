'use strict';

const assert = require('node:assert/strict');
const mod = require('../cancelledRow.cjs');
const { isCancelledRow, CANCEL_STATUSES, CANCEL_SOURCE, CANCEL_ERROR_PREFIX } = mod;

const AT = '2026-11-23T10:00:00.000Z';
const h = (from, to, source) => ({ from, to, source, at: AT });

describe('cancelledRow exports', () => {
  it('constants', () => {
    assert.ok(CANCEL_STATUSES instanceof Set);
    assert.deepEqual([...CANCEL_STATUSES].sort(), ['failed', 'needs_review']);
    assert.equal(CANCEL_SOURCE, 'remote:cancelJob');
    assert.equal(CANCEL_ERROR_PREFIX, 'cancelled via admin API');
  });
});

describe('isCancelledRow — true for every shape remote.cancelJob writes', () => {
  it('failed + cancelledAt (pending cancel)', () => {
    assert.equal(isCancelledRow({
      status: 'failed', cancelledAt: AT, error: 'cancelled via admin API',
      statusHistory: [h('pending', 'failed', 'remote:cancelJob')],
    }), true);
  });
  it('needs_review + cancelledAt (running cancel whose landedCommit resolves)', () => {
    assert.equal(isCancelledRow({
      status: 'needs_review', cancelledAt: AT,
      error: 'cancelled via admin API, but landedCommit abc resolves — verify before treating as done',
      statusHistory: [h('pending', 'running', 'dispatch'), h('running', 'needs_review', 'remote:cancelJob')],
    }), true);
  });
  it('cascaded dependent', () => {
    assert.equal(isCancelledRow({
      status: 'failed', cancelledAt: AT,
      error: 'cancelled via admin API (cascade: depends on cancelled x)',
      statusHistory: [h('pending', 'failed', 'remote:cancelJob')],
    }), true);
  });
  it('dismiss cascade (queueOps:dismissCancelled source + cancelledAt)', () => {
    assert.equal(isCancelledRow({
      status: 'failed', cancelledAt: AT, error: 'dismissed: depends on cancelled x',
      statusHistory: [h('pending', 'failed', 'queueOps:dismissCancelled')],
    }), true);
  });
  it('statusHistory-only legacy row', () => {
    assert.equal(isCancelledRow({
      status: 'failed', error: 'killed',
      statusHistory: [h('pending', 'running', 'dispatch'), h('running', 'failed', 'remote:cancelJob')],
    }), true);
  });
  it('error-only legacy row', () => {
    assert.equal(isCancelledRow({ status: 'failed', error: 'cancelled via admin API' }), true);
  });
});

describe('isCancelledRow — false for everything else', () => {
  it('a real failure', () => {
    assert.equal(isCancelledRow({
      status: 'failed', error: 'exit 1',
      statusHistory: [h('pending', 'running', 'dispatch'), h('running', 'failed', 'runner:finalize')],
    }), false);
  });
  it('a real needs_review park', () => {
    assert.equal(isCancelledRow({
      status: 'needs_review', error: 'gate red',
      statusHistory: [h('pending', 'running', 'dispatch'), h('running', 'needs_review', 'runner:finalize')],
    }), false);
  });
  it('a reset row', () => {
    assert.equal(isCancelledRow({
      status: 'pending',
      statusHistory: [h('pending', 'failed', 'remote:cancelJob'), h('failed', 'pending', 'remote:resetJob')],
    }), false);
  });
  it('cancelled, reset, then failed for real (no cancelledAt)', () => {
    assert.equal(isCancelledRow({
      status: 'failed', error: 'exit 1',
      statusHistory: [
        h('pending', 'failed', 'remote:cancelJob'),
        h('failed', 'pending', 'remote:resetJob'),
        h('pending', 'running', 'dispatch'),
        h('running', 'failed', 'runner:finalize'),
      ],
    }), false);
  });
  it('completed or running rows carrying a cancelledAt', () => {
    assert.equal(isCancelledRow({ status: 'completed', cancelledAt: AT, error: 'cancelled via admin API' }), false);
    assert.equal(isCancelledRow({ status: 'running', cancelledAt: AT }), false);
  });
  it('null, undefined, non-objects', () => {
    assert.equal(isCancelledRow(null), false);
    assert.equal(isCancelledRow(undefined), false);
    assert.equal(isCancelledRow('failed'), false);
    assert.equal(isCancelledRow(42), false);
  });
});
