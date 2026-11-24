'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/memoryGateMeasured.test.cjs
// PRD 4019 — the memory gate reserves measured per-agentType peaks instead of a flat 2.5 GB/job.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { measuredMemoryGate, formatMemoryGateDetail } = require('../loadGate.cjs');
const { createJobMemoryStats, STORE_FILE } = require('../jobMemoryStats.cjs');
const { availableForJobs, heartbeatMemGate } = require('../../../scheduler.cjs');

// The old flat rule, written out literally: the largest k ≤ batchLen with
// available ≥ flat × (running + k) − credit, credit = min(consumed, flat × running).
function flatRule(availableMb, flatMb, runningCount, batchLen, consumedMb) {
  if (availableMb === Infinity) return batchLen;
  const credit = Math.min(Math.max(consumedMb, 0), flatMb * runningCount);
  let k = batchLen;
  while (k > 0 && availableMb < flatMb * (runningCount + k) - credit) k--;
  return k;
}

const RESERVED_HOST_MB = 3000;
const FLAT_MB = 2500;

const measuredStats = {
  isMeasured: () => true,
  reservationMb: () => 1300, // p75
  spikeBufferMb: () => 1400,
  typicalPeakMb: () => 700, // p50
};

function gateOnce(freeMb, running, batchLen, stats) {
  return measuredMemoryGate({
    jobBudgetMb: availableForJobs(freeMb, RESERVED_HOST_MB),
    running,
    batch: Array.from({ length: batchLen }, () => ({ agentType: 'dev-lead' })),
    stats,
  });
}

describe('measuredMemoryGate — the PRD scenario', () => {
  it('admits one job per tick until 9 run and holds the 10th', () => {
    let free = 10_500;
    const running = Array.from({ length: 3 }, () => ({ agentType: 'dev-lead', rssMb: 300 }));
    let last;
    for (let tick = 0; tick < 20; tick++) {
      last = gateOnce(free, running, 1, measuredStats);
      if (last.allowed === 0) break;
      running.push({ agentType: 'dev-lead', rssMb: 300 });
      free -= 300; // each started job lowers free memory by 300 MB
    }
    assert.equal(running.length, 9);
    assert.equal(last.allowed, 0);
    // The held tick names its terms: new job p75, one shared buffer, 9 × (700 − 300) growth.
    assert.equal(last.reservationMb, 1300);
    assert.equal(last.spikeBufferMb, 1400);
    assert.equal(last.growthMb, 9 * 400);
    assert.equal(RESERVED_HOST_MB + last.needMb, 3000 + 1300 + 1400 + 3600);
    assert.ok(free < RESERVED_HOST_MB + last.needMb);
  });

  it('the flat 2,500 MB rule admitted none of them (needs 12.1 GB for a 4th job)', () => {
    const consumed = 3 * 300;
    assert.equal(flatRule(availableForJobs(10_500, RESERVED_HOST_MB), FLAT_MB, 3, 1, consumed), 0);
    assert.equal(RESERVED_HOST_MB + FLAT_MB * 4 - consumed, 12_100);
  });

  it('first tick threshold is host + p75 + buffer + Σ max(0, p50 − RSS)', () => {
    const g = gateOnce(10_500, Array.from({ length: 3 }, () => ({ rssMb: 300 })), 1, measuredStats);
    assert.equal(g.allowed, 1);
    assert.equal(RESERVED_HOST_MB + g.needMb, 3000 + 1300 + 1400 + 3 * 400);
    assert.equal(g.consumedMb, 900);
  });

  it('a running job above its typical peak contributes no growth and no negative term', () => {
    const g = gateOnce(10_000, [{ rssMb: 5000 }], 1, measuredStats);
    assert.equal(g.growthMb, 0);
    assert.equal(g.consumedMb, 700);
  });

  it('several new jobs in one tick each reserve their own p75; one shared buffer', () => {
    // budget 7000: 1400 + 1300k ≤ 7000 → k = 4
    const g = gateOnce(10_000, [], 6, measuredStats);
    assert.equal(g.allowed, 4);
    assert.equal(g.spikeBufferMb, 1400);
  });

  it('per-agentType reservation of the next job is used', () => {
    const stats = { ...measuredStats, reservationMb: (t) => (t === 'validator' ? 3000 : 1300) };
    const g = measuredMemoryGate({ jobBudgetMb: 4000, running: [], batch: [{ agentType: 'validator' }], stats });
    assert.equal(g.allowed, 0);
    assert.equal(g.reservationMb, 3000);
    const g2 = measuredMemoryGate({ jobBudgetMb: 4000, running: [], batch: [{ agentType: 'dev-lead' }], stats });
    assert.equal(g2.allowed, 1);
  });

  it('Infinity budget (non-Linux) admits the whole batch', () => {
    assert.equal(measuredMemoryGate({ jobBudgetMb: Infinity, running: [], batch: [{}, {}, {}], stats: measuredStats }).allowed, 3);
  });
});

describe('measuredMemoryGate — no samples equals the flat rule', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memgate-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('an empty store reproduces the flat 2,500 MB rule over a grid', () => {
    const stats = createJobMemoryStats({ storePath: path.join(tmp, STORE_FILE), now: () => 1 });
    assert.equal(stats.isMeasured(), false);
    for (const free of [0, 2000, 5499, 5500, 8000, 10_500, 12_099, 12_100, 20_000]) {
      for (const runningCount of [0, 1, 3, 5]) {
        for (const rss of [0, 300, 2500, 9000]) {
          for (const batchLen of [1, 3]) {
            const running = Array.from({ length: runningCount }, () => ({ agentType: 'dev-lead', rssMb: rss }));
            const g = measuredMemoryGate({
              jobBudgetMb: availableForJobs(free, RESERVED_HOST_MB),
              running,
              batch: Array.from({ length: batchLen }, () => ({ agentType: 'dev-lead' })),
              stats,
            });
            const consumed = Math.min(rss, FLAT_MB) * runningCount;
            const flat = flatRule(availableForJobs(free, RESERVED_HOST_MB), FLAT_MB, runningCount, batchLen, consumed);
            assert.equal(g.allowed, flat, `free=${free} running=${runningCount} rss=${rss} batch=${batchLen}`);
            assert.equal(g.spikeBufferMb, 0);
            assert.equal(g.measured, false);
          }
        }
      }
    }
  });

  it('with >= 30 samples the store switches to measured terms', () => {
    const file = path.join(tmp, STORE_FILE);
    fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => JSON.stringify({ agentType: 'dev-lead', peakMb: 600 + i * 20, at: i })).join('\n') + '\n');
    const stats = createJobMemoryStats({ storePath: file, now: () => 1 });
    const g = measuredMemoryGate({ jobBudgetMb: 10_000, running: [{ agentType: 'dev-lead', rssMb: 0 }], batch: [{ agentType: 'dev-lead' }], stats });
    assert.equal(g.measured, true);
    assert.equal(g.reservationMb, stats.reservationMb('dev-lead'));
    assert.equal(g.growthMb, stats.typicalPeakMb('dev-lead'));
    assert.equal(g.spikeBufferMb, stats.spikeBufferMb());
  });
});

describe('memory-gate detail + heartbeat', () => {
  it('the tick detail names the reservation, the spike buffer and the running growth', () => {
    const gate = gateOnce(8000, Array.from({ length: 9 }, () => ({ rssMb: 300 })), 1, measuredStats);
    const threshold = RESERVED_HOST_MB + gate.needMb;
    const d = formatMemoryGateDetail({ availableMb: 8000, threshold, reservedHostMb: RESERVED_HOST_MB, gate });
    assert.match(d, /^memory gate: 8000 MB free, need 9300 MB/);
    assert.match(d, /new job 1300/);
    assert.match(d, /spike buffer 1400/);
    assert.match(d, /running growth 3600/);
  });

  it('heartbeatMemGate carries the three terms and is null when ungated', () => {
    assert.equal(heartbeatMemGate(null), null);
    const hb = heartbeatMemGate({ availableMb: 8000, threshold: 9300, reservationMb: 1300, spikeBufferMb: 1400, runningGrowthMb: 3600, consumedMb: 2700, measured: true, deferred: true, at: 'x' });
    assert.deepEqual(hb, { availableMb: 8000, threshold: 9300, reservationMb: 1300, spikeBufferMb: 1400, runningGrowthMb: 3600, consumedMb: 2700, measured: true, deferred: true, at: 'x' });
  });
});
