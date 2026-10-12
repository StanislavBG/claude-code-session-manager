'use strict';

const assert = require('node:assert/strict');
const { shouldRunFlatSweep, FLAT_SWEEP_INTERVAL_MS } = require('../flatSweepThrottle.cjs');

describe('shouldRunFlatSweep', () => {
  it('interval is one hour', () => {
    assert.equal(FLAT_SWEEP_INTERVAL_MS, 3600000);
  });
  it('runs when never run before', () => {
    assert.equal(shouldRunFlatSweep(1000, null, FLAT_SWEEP_INTERVAL_MS), true);
  });
  it('skips within the interval', () => {
    assert.equal(shouldRunFlatSweep(1000 + FLAT_SWEEP_INTERVAL_MS - 1, 1000, FLAT_SWEEP_INTERVAL_MS), false);
  });
  it('runs at and past the interval', () => {
    assert.equal(shouldRunFlatSweep(1000 + FLAT_SWEEP_INTERVAL_MS, 1000, FLAT_SWEEP_INTERVAL_MS), true);
    assert.equal(shouldRunFlatSweep(1000 + 2 * FLAT_SWEEP_INTERVAL_MS, 1000, FLAT_SWEEP_INTERVAL_MS), true);
  });
});
