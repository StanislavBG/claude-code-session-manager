'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/cpuSample.test.cjs
const assert = require('node:assert/strict');
const {
  parseProcStat,
  readCpuTimes,
  createCpuSampler,
  DEFAULT_WINDOW_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  MIN_SPACING_MS,
} = require('../cpuSample.cjs');

const FIXTURE =
  'cpu  73932358 411144223 101530159 3435389467 42421499 0 592579 0 0 0\n' +
  'cpu0 5000 29000 7000 245000000 3000 0 40000 0 0 0\n';

describe('constants', () => {
  it('exports defaults', () => {
    assert.equal(DEFAULT_WINDOW_MS, 60000);
    assert.equal(MIN_WINDOW_MS, 20000);
    assert.equal(MAX_WINDOW_MS, 180000);
    assert.equal(MIN_SPACING_MS, 5000);
  });
});

describe('parseProcStat', () => {
  it('parses the aggregate line, not cpu0', () => {
    const total = 73932358 + 411144223 + 101530159 + 3435389467 + 42421499 + 0 + 592579 + 0;
    assert.deepEqual(parseProcStat(FIXTURE), { busy: total - 3435389467, total });
  });
  it('ignores guest columns', () => {
    assert.deepEqual(parseProcStat('cpu 1 2 3 4 5 6 7 8 900 900\n'), { busy: 32, total: 36 });
  });
  it('treats missing trailing columns as 0', () => {
    assert.deepEqual(parseProcStat('cpu 1 2 3 4\n'), { busy: 6, total: 10 });
  });
  it('returns null for bad input', () => {
    assert.equal(parseProcStat(''), null);
    assert.equal(parseProcStat('cpu0 1 2 3 4\n'), null);
    assert.equal(parseProcStat('cpu 1 2 3\n'), null);
    assert.equal(parseProcStat('cpu 1 2 x 4\n'), null);
  });
});

describe('readCpuTimes', () => {
  it('parses /proc/stat on linux', () => {
    const r = readCpuTimes({ platform: 'linux', readFile: () => 'cpu 1 2 3 4\n' });
    assert.deepEqual(r, { busy: 6, total: 10 });
  });
  it('sums os.cpus() elsewhere', () => {
    const cpus = () => [
      { times: { user: 1, nice: 2, sys: 3, idle: 10, irq: 4 } },
      { times: { user: 1, nice: 0, sys: 1, idle: 20, irq: 0 } },
    ];
    assert.deepEqual(readCpuTimes({ platform: 'win32', cpus }), { busy: 12, total: 42 });
  });
  it('returns null on throw or empty cpu list', () => {
    assert.equal(readCpuTimes({ platform: 'linux', readFile: () => { throw new Error('x'); } }), null);
    assert.equal(readCpuTimes({ platform: 'darwin', cpus: () => [] }), null);
    assert.equal(readCpuTimes({ platform: 'darwin', cpus: () => { throw new Error('x'); } }), null);
  });
  it.runIf(process.platform === 'linux')('reads the real /proc/stat', () => {
    const r = readCpuTimes();
    assert.ok(r.busy > 0 && r.busy <= r.total);
  });
});

function harness() {
  let t = 1_000_000;
  let cur = { busy: 0, total: 0 };
  const s = createCpuSampler({ now: () => t, read: () => cur });
  return {
    s,
    at(ms, reading) { t = 1_000_000 + ms; cur = reading; },
  };
}

describe('createCpuSampler', () => {
  it('observe skips null reads and too-close readings', () => {
    const h = harness();
    h.at(0, null);
    h.s.observe();
    h.at(0, { busy: 0, total: 0 });
    h.s.observe();
    h.at(1000, { busy: 10, total: 100 });
    h.s.observe(); // too close to previous: skipped
    h.at(61_000, { busy: 50, total: 200 });
    // only the t=0 entry stored: delta busy 50 / total 200
    assert.deepEqual(h.s.sample(), { busyFraction: 0.25, windowMs: 61_000 });
  });

  it('picks the stored reading closest to windowMs among 30/60/90 s', () => {
    const h = harness();
    h.at(0, { busy: 0, total: 0 }); h.s.observe();      // age 90 at sample
    h.at(30_000, { busy: 10, total: 100 }); h.s.observe(); // age 60
    h.at(60_000, { busy: 20, total: 200 }); h.s.observe(); // age 30
    h.at(90_000, { busy: 70, total: 300 });
    assert.deepEqual(h.s.sample(), { busyFraction: 0.3, windowMs: 60_000 });
  });

  it('skips entries younger than minWindowMs', () => {
    const h = harness();
    h.at(0, { busy: 0, total: 0 }); h.s.observe();
    h.at(10_000, { busy: 5, total: 10 });
    assert.equal(h.s.sample(), null);
  });

  it('drops entries past maxWindowMs', () => {
    const h = harness();
    h.at(0, { busy: 0, total: 0 }); h.s.observe();
    h.at(100_000, { busy: 1, total: 10 }); h.s.observe();
    h.at(190_000, { busy: 2, total: 20 }); h.s.observe(); // evicts t=0
    h.at(200_000, { busy: 3, total: 30 });
    // t=0 would be 200s old: gone; t=100s is 100s old
    assert.deepEqual(h.s.sample(), { busyFraction: 2 / 20, windowMs: 100_000 });
    h.at(400_000, { busy: 9, total: 90 });
    assert.equal(h.s.sample(), null);
  });

  it('includes boundary ages inclusively', () => {
    const h = harness();
    h.at(0, { busy: 0, total: 0 }); h.s.observe();
    h.at(MIN_WINDOW_MS, { busy: 1, total: 4 });
    assert.deepEqual(h.s.sample(), { busyFraction: 0.25, windowMs: MIN_WINDOW_MS });
    h.at(MAX_WINDOW_MS, { busy: 1, total: 4 });
    assert.deepEqual(h.s.sample(), { busyFraction: 0.25, windowMs: MAX_WINDOW_MS });
  });

  it('clamps busyFraction to 1', () => {
    const h = harness();
    h.at(0, { busy: 0, total: 0 }); h.s.observe();
    h.at(60_000, { busy: 150, total: 100 });
    assert.equal(h.s.sample().busyFraction, 1);
  });

  it('returns null for null fresh reading, non-positive total delta, negative busy delta', () => {
    const h = harness();
    h.at(0, { busy: 100, total: 200 }); h.s.observe();
    h.at(60_000, null);
    assert.equal(h.s.sample(), null);
    h.at(60_000, { busy: 100, total: 200 });
    assert.equal(h.s.sample(), null);
    h.at(60_000, { busy: 90, total: 300 });
    assert.equal(h.s.sample(), null);
  });
});
