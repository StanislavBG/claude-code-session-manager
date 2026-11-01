const { describeSlotHold } = require('../scheduler/budget.cjs');

const holders = [{ owner: 'a' }, { owner: 'b' }];

describe('describeSlotHold', () => {
  it('names the degraded meter cap when the pool is mostly free', () => {
    const r = describeSlotHold({ total: 10, inUse: 3, holders, degradedCap: 2, running: 2, deferredCount: 4 });
    expect(r.reason).toBe('usage-meter-degraded');
    expect(r.detail).toBe('usage meter down: running capped at 2 (2 running, 3 of 10 slots in use)');
  });
  it('reports slots-exhausted with the real inUse and total', () => {
    const r = describeSlotHold({ total: 10, inUse: 10, holders, degradedCap: null, running: 2, deferredCount: 1 });
    expect(r.reason).toBe('slots-exhausted');
    expect(r.detail).toContain('10 of 10 session slots busy');
    expect(r.detail).toContain('a, b');
  });
  it('prints real inUse, not the total twice', () => {
    const r = describeSlotHold({ total: 10, inUse: 7, holders, degradedCap: null, running: 2, deferredCount: 1 });
    expect(r.detail).toContain('7 of 10');
    expect(r.detail).not.toContain('10 of 10');
  });
  it('stays slots-exhausted when the pool is truly full and the meter is degraded', () => {
    const r = describeSlotHold({ total: 10, inUse: 10, holders, degradedCap: 2, running: 2, deferredCount: 1 });
    expect(r.reason).toBe('slots-exhausted');
  });
});
