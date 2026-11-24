'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/jobMemoryStats.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJobMemoryStats, quantile, MAX_SAMPLES, CACHE_MS, STORE_FILE } = require('../jobMemoryStats.cjs');

let tmp;
let clock;
function make() {
  return createJobMemoryStats({ storePath: path.join(tmp, STORE_FILE), now: () => clock });
}
function writeStore(samples) {
  fs.writeFileSync(path.join(tmp, STORE_FILE), samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
}
const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmem-'));
  clock = 1_000_000;
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('quantile (nearest-rank)', () => {
  it('picks ceil(q*n)-th smallest', () => {
    const v = seq(100, (i) => i + 1); // 1..100
    assert.equal(quantile(v, 0.5), 50);
    assert.equal(quantile(v, 0.75), 75);
    assert.equal(quantile(v, 0.95), 95);
    assert.equal(quantile([5], 0.75), 5);
  });
});

describe('reservationMb / typicalPeakMb', () => {
  it('defaults to 2500 / 1000 with fewer than 30 samples', () => {
    writeStore(seq(29, () => ({ agentType: 'dev-lead', peakMb: 1500, at: 1 })));
    const s = make();
    assert.equal(s.reservationMb('dev-lead'), 2500);
    assert.equal(s.typicalPeakMb('dev-lead'), 1000);
    assert.equal(s.reservationMb('validator'), 2500);
  });

  it('uses p75 / p50 of the agentType own samples when it has >= 30', () => {
    writeStore([
      ...seq(40, (i) => ({ agentType: 'dev-lead', peakMb: 1000 + i * 10, at: i })), // 1000..1390
      ...seq(40, () => ({ agentType: 'validator', peakMb: 3500, at: 1 })),
    ]);
    const s = make();
    assert.equal(s.reservationMb('dev-lead'), 1000 + 29 * 10); // rank 30 of 40
    assert.equal(s.typicalPeakMb('dev-lead'), 1000 + 19 * 10); // rank 20 of 40
    assert.equal(s.reservationMb('validator'), 3500);
    assert.equal(s.typicalPeakMb('validator'), 2500); // clamped from 3500
  });

  it('uses only the newest 200 of an agentType', () => {
    writeStore([
      ...seq(300, () => ({ agentType: 'dev-lead', peakMb: 3900, at: 1 })),
      ...seq(200, () => ({ agentType: 'dev-lead', peakMb: 1200, at: 2 })),
    ]);
    const s = make();
    assert.equal(s.reservationMb('dev-lead'), 1200);
    assert.equal(s.typicalPeakMb('dev-lead'), 1200);
  });

  it('falls back to all samples when the agentType has < 30 but the store has >= 30', () => {
    writeStore([
      ...seq(10, () => ({ agentType: 'rare', peakMb: 3900, at: 1 })),
      ...seq(30, (i) => ({ agentType: 'dev-lead', peakMb: 1000 + i, at: 1 })),
    ]);
    const s = make();
    // all 40: 30 values 1000..1029 then 10 × 3900; p75 = rank 30 → 1029, p50 = rank 20 → 1019
    assert.equal(s.reservationMb('rare'), 1029);
    assert.equal(s.typicalPeakMb('rare'), 1019);
  });

  it('clamps reservation to 800-4000 and typical to 300-2500', () => {
    writeStore(seq(30, () => ({ agentType: 'tiny', peakMb: 100, at: 1 })));
    let s = make();
    assert.equal(s.reservationMb('tiny'), 800);
    assert.equal(s.typicalPeakMb('tiny'), 300);
    writeStore(seq(30, () => ({ agentType: 'huge', peakMb: 9000, at: 1 })));
    s = make();
    assert.equal(s.reservationMb('huge'), 4000);
    assert.equal(s.typicalPeakMb('huge'), 2500);
  });
});

describe('spikeBufferMb', () => {
  it('is 1500 with fewer than 30 samples', () => {
    writeStore(seq(29, (i) => ({ agentType: 'a', peakMb: i * 1000, at: 1 })));
    assert.equal(make().spikeBufferMb(), 1500);
  });
  it('is p95 - p75 of all samples', () => {
    writeStore(seq(100, (i) => ({ agentType: i % 2 ? 'a' : 'b', peakMb: (i + 1) * 50, at: 1 }))); // 50..5000
    assert.equal(make().spikeBufferMb(), 95 * 50 - 75 * 50); // 1000
  });
  it('clamps to 500-3000', () => {
    writeStore(seq(40, () => ({ agentType: 'a', peakMb: 1000, at: 1 })));
    assert.equal(make().spikeBufferMb(), 500);
    writeStore([...seq(30, () => ({ agentType: 'a', peakMb: 500, at: 1 })), ...seq(10, () => ({ agentType: 'a', peakMb: 9000, at: 1 }))]);
    assert.equal(make().spikeBufferMb(), 3000);
  });
});

describe('store', () => {
  it('recordPeak appends JSON lines and trims to the newest 2000', () => {
    writeStore(seq(MAX_SAMPLES, (i) => ({ agentType: 'old', peakMb: i, at: i })));
    const s = make();
    assert.deepEqual(s.recordPeak({ agentType: 'dev-lead', peakMb: 1234.4, at: 99 }), { agentType: 'dev-lead', peakMb: 1234, at: 99 });
    const lines = fs.readFileSync(path.join(tmp, STORE_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, MAX_SAMPLES);
    assert.equal(lines[0].peakMb, 1); // oldest (0) dropped
    assert.deepEqual(lines[lines.length - 1], { agentType: 'dev-lead', peakMb: 1234, at: 99 });
  });

  it('recordPeak rejects unusable input and defaults at to now()', () => {
    const s = make();
    assert.equal(s.recordPeak({ agentType: 'x', peakMb: NaN }), null);
    assert.equal(s.recordPeak({ agentType: 'x', peakMb: -1 }), null);
    assert.deepEqual(s.recordPeak({ peakMb: 10 }), { agentType: 'unknown', peakMb: 10, at: clock });
  });

  it('skips torn lines and caches reads for 60 s', () => {
    writeStore(seq(30, () => ({ agentType: 'a', peakMb: 1000, at: 1 })));
    fs.appendFileSync(path.join(tmp, STORE_FILE), '{"agentType":"a","peak\n');
    const s = make();
    assert.equal(s.reservationMb('a'), 1000);
    writeStore(seq(30, () => ({ agentType: 'a', peakMb: 2000, at: 1 }))); // external rewrite
    assert.equal(s.reservationMb('a'), 1000); // cached
    clock += CACHE_MS;
    assert.equal(s.reservationMb('a'), 2000);
  });

  it('a recordPeak refreshes the cache immediately', () => {
    const s = make();
    assert.equal(s.reservationMb('a'), 2500);
    for (let i = 0; i < 30; i++) s.recordPeak({ agentType: 'a', peakMb: 1500, at: i });
    assert.equal(s.reservationMb('a'), 1500);
  });
});

describe('backfillFromRunLogs', () => {
  function writeLog(rel, text, mtimeSec) {
    const p = path.join(tmp, 'runs', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    fs.utimesSync(p, mtimeSec, mtimeSec);
    return p;
  }

  it('parses memory-scope peak lines as agentType unknown', () => {
    writeLog('run-1/a.log', 'noise\n[scheduler] memory scope sm-job-a.scope: peak=1269MB oom_kill=0\n', 1000);
    writeLog('run-2/b.log', '[scheduler] memory scope sm-job-b.scope: peak=n/a oom_kill=0\n[scheduler] memory scope sm-job-c.scope: peak=670MB oom_kill=n/a\n', 2000);
    writeLog('run-2/b.meta.json', '[scheduler] memory scope x: peak=9999MB', 3000); // not a .log
    const s = make();
    assert.equal(s.backfillFromRunLogs([path.join(tmp, 'runs'), path.join(tmp, 'missing')]), 2);
    const lines = fs.readFileSync(path.join(tmp, STORE_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [
      { agentType: 'unknown', peakMb: 1269, at: 1_000_000 },
      { agentType: 'unknown', peakMb: 670, at: 2_000_000 },
    ]);
  });

  it('reads only the newest maxFiles logs', () => {
    writeLog('r1/old.log', '[scheduler] memory scope u1: peak=100MB\n', 1000);
    writeLog('r2/mid.log', '[scheduler] memory scope u2: peak=200MB\n', 2000);
    writeLog('r3/new.log', '[scheduler] memory scope u3: peak=300MB\n', 3000);
    const s = make();
    assert.equal(s.backfillFromRunLogs([path.join(tmp, 'runs')], { maxFiles: 2 }), 2);
    const peaks = fs.readFileSync(path.join(tmp, STORE_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l).peakMb);
    assert.deepEqual(peaks, [200, 300]);
  });

  it('is a no-op when the store already has samples', () => {
    writeStore([{ agentType: 'dev-lead', peakMb: 500, at: 1 }]);
    writeLog('r1/a.log', '[scheduler] memory scope u1: peak=100MB\n', 1000);
    const s = make();
    assert.equal(s.backfillFromRunLogs([path.join(tmp, 'runs')]), 0);
    assert.equal(fs.readFileSync(path.join(tmp, STORE_FILE), 'utf8').trim().split('\n').length, 1);
  });

  it('never throws on unreadable files or bad input', () => {
    const p = writeLog('r1/a.log', '[scheduler] memory scope u1: peak=100MB\n', 1000);
    writeLog('r1/b.log', '[scheduler] memory scope u2: peak=200MB\n', 2000);
    const realRead = fs.readFileSync;
    const s = createJobMemoryStats({
      storePath: path.join(tmp, STORE_FILE),
      now: () => clock,
      fs: { ...fs, readFileSync: (f, ...a) => { if (f === p) throw new Error('EACCES'); return realRead(f, ...a); } },
    });
    assert.equal(s.backfillFromRunLogs([path.join(tmp, 'runs')]), 1);
    assert.doesNotThrow(() => s.backfillFromRunLogs(null));
    assert.doesNotThrow(() => make().backfillFromRunLogs([42, '']));
  });
});
