'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/jobMemoryStats.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJobMemoryStats, quantile, MAX_SAMPLES, CACHE_MS, STORE_FILE, BACKFILL_BATCH } = require('../jobMemoryStats.cjs');

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
  const RUNS = () => path.join(tmp, 'runs');
  function writeLog(rel, text, mtimeSec) {
    const p = path.join(tmp, 'runs', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    fs.utimesSync(p, mtimeSec, mtimeSec);
    return p;
  }
  const peakLine = (unit, mb) => `[scheduler] memory scope ${unit}: peak=${mb}MB oom_kill=0\n`;
  const storeLines = () => fs.readFileSync(path.join(tmp, STORE_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // A real-looking runs folder: <ISO-timestamp runId>/<slug>.log, plus non-log siblings.
  function seedRuns(n) {
    for (let i = 0; i < n; i++) {
      const runId = `2026-11-${String(10 + i).padStart(2, '0')}T05-48-50-604Z`;
      writeLog(`${runId}/job-${i}.log`, `noise\n${peakLine(`sm-job-job-${i}-${i}`, 100 + i)}`, 1000 + i);
      writeLog(`${runId}/job-${i}.supervisor.json`, peakLine('x', 9999), 1000 + i);
    }
    fs.writeFileSync(path.join(RUNS(), 'queue-cleanup.log'), peakLine('top-level-file', 9999));
  }

  it('parses memory-scope peak lines as agentType unknown, tagged with run folder + unit', async () => {
    writeLog('run-1/a.log', 'noise\n[scheduler] memory scope sm-job-a.scope: peak=1269MB oom_kill=0\n', 1000);
    writeLog('run-2/b.log', '[scheduler] memory scope sm-job-b.scope: peak=n/a oom_kill=0\n[scheduler] memory scope sm-job-c.scope: peak=670MB oom_kill=n/a\n', 2000);
    writeLog('run-2/b.meta.json', '[scheduler] memory scope x: peak=9999MB', 3000); // not a .log
    const s = make();
    assert.equal(await s.backfillFromRunLogs(RUNS()), 2);
    assert.deepEqual(storeLines(), [
      { agentType: 'unknown', peakMb: 1269, at: 1_000_000, runId: 'run-1', unit: 'sm-job-a.scope' },
      { agentType: 'unknown', peakMb: 670, at: 2_000_000, runId: 'run-2', unit: 'sm-job-c.scope' },
    ]);
  });

  it('a missing runs folder or bad input adds nothing and never throws', async () => {
    const s = make();
    assert.equal(await s.backfillFromRunLogs(path.join(tmp, 'missing')), 0);
    assert.equal(await s.backfillFromRunLogs(null), 0);
    assert.equal(await s.backfillFromRunLogs(42), 0);
    assert.equal(await s.backfillFromRunLogs(''), 0);
  });

  it('walks run folders newest first by name and stops at maxFiles logs, with bounded fs reads', async () => {
    seedRuns(20);
    const calls = { readdir: 0, readFile: 0, stat: 0 };
    const counted = {
      ...fs,
      promises: {
        ...fs.promises,
        readdir: (...a) => { calls.readdir++; return fs.promises.readdir(...a); },
        readFile: (f, ...a) => { if (String(f).endsWith('.log')) calls.readFile++; return fs.promises.readFile(f, ...a); },
        stat: (...a) => { calls.stat++; return fs.promises.stat(...a); },
      },
    };
    const s = createJobMemoryStats({ storePath: path.join(tmp, STORE_FILE), now: () => clock, fs: counted });
    assert.equal(await s.backfillFromRunLogs(RUNS(), { maxFiles: 3 }), 3);
    // newest three folders (by name), stored oldest first like the live store
    assert.deepEqual(storeLines().map((l) => l.peakMb), [117, 118, 119]);
    assert.ok(!storeLines().some((l) => l.peakMb === 9999), 'non-log and top-level files are ignored');
    // 1 runs listing + 3 folder listings; 3 log reads; ≤ 3 stats (one per read log)
    assert.ok(calls.readdir <= 4, `readdir=${calls.readdir}`);
    assert.equal(calls.readFile, 3, `readFile=${calls.readFile}`);
    assert.ok(calls.stat <= 3, `stat=${calls.stat}`);
  });

  it('a store under 30 samples re-seeds and never duplicates a recorded run folder + unit', async () => {
    seedRuns(20);
    writeStore(seq(5, (i) => ({ agentType: 'dev-lead', peakMb: 500, at: i })));
    const s = make();
    assert.equal(await s.backfillFromRunLogs(RUNS(), { maxFiles: 10 }), 10);
    assert.equal(storeLines().length, 15);
    // next boot: still under 30 → runs again, but the same 10 logs add nothing
    assert.equal(await s.backfillFromRunLogs(RUNS(), { maxFiles: 10 }), 0);
    assert.equal(storeLines().length, 15);
    // a wider walk adds only the unseen ones
    assert.equal(await s.backfillFromRunLogs(RUNS(), { maxFiles: 12 }), 2);
    assert.equal(storeLines().length, 17);
  });

  it('a live-recorded peak with the same unit is not re-added from its log', async () => {
    seedRuns(2);
    const s = make();
    s.recordPeak({ agentType: 'dev-lead', peakMb: 101, at: 5, unit: 'sm-job-job-1-1' });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 1);
    assert.deepEqual(storeLines().map((l) => [l.agentType, l.peakMb]), [['dev-lead', 101], ['unknown', 100]]);
  });

  it('on a sparse runs folder lists at most maxFiles x 2 run folders, newest first, logs or not', async () => {
    // 40 run folders, only the oldest 2 hold a log; the newest 38 hold only sidecars.
    for (let i = 0; i < 40; i++) {
      const runId = `2026-10-${String(i).padStart(2, '0')}T00-00-00-000Z`;
      if (i < 2) writeLog(`${runId}/job-${i}.log`, peakLine(`sm-job-old-${i}`, 100 + i), 1000 + i);
      else writeLog(`${runId}/job-${i}.meta.json`, '{}', 1000 + i);
    }
    const listed = [];
    const counted = {
      ...fs,
      promises: { ...fs.promises, readdir: (d, ...a) => { listed.push(path.basename(String(d))); return fs.promises.readdir(d, ...a); } },
    };
    const s = createJobMemoryStats({ storePath: path.join(tmp, STORE_FILE), now: () => clock, fs: counted });
    assert.equal(await s.backfillFromRunLogs(RUNS(), { maxFiles: 5 }), 0);
    // 1 runs-folder listing + the newest 10 run folders, never the 30 older ones (nor the 2 logs).
    assert.equal(listed[0], 'runs');
    const runListings = listed.slice(1);
    assert.equal(runListings.length, 10);
    assert.deepEqual(runListings, seq(10, (k) => `2026-10-${String(39 - k).padStart(2, '0')}T00-00-00-000Z`));
    assert.equal(fs.existsSync(path.join(tmp, STORE_FILE)), false);
    // A budget wide enough to reach the old logs finds them.
    assert.equal(await s.backfillFromRunLogs(RUNS(), { maxFiles: 20 }), 2);
  });

  it('dedupes by run folder + unit: the same unit in another run folder is a new peak', async () => {
    writeLog('run-1/a.log', peakLine('sm-job-x', 100), 1000);
    writeLog('run-2/a.log', peakLine('sm-job-x', 200), 2000);
    writeStore([{ agentType: 'dev-lead', peakMb: 100, at: 1, runId: 'run-1', unit: 'sm-job-x' }]);
    const s = make();
    assert.equal(await s.backfillFromRunLogs(RUNS()), 1);
    assert.deepEqual(storeLines().map((l) => [l.runId, l.unit, l.peakMb]), [['run-1', 'sm-job-x', 100], ['run-2', 'sm-job-x', 200]]);
    // Both folder + unit pairs are stored now: a rerun adds nothing.
    assert.equal(await s.backfillFromRunLogs(RUNS()), 0);
    assert.equal(storeLines().length, 2);
  });

  it('a live peak recorded with its run folder is not re-added, its unit elsewhere is', async () => {
    writeLog('run-1/a.log', peakLine('sm-job-y', 300), 1000);
    writeLog('run-2/a.log', peakLine('sm-job-y', 400), 2000);
    const s = make();
    s.recordPeak({ agentType: 'dev-lead', peakMb: 301, at: 5, runId: 'run-1', unit: 'sm-job-y' });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 1);
    assert.deepEqual(storeLines().map((l) => [l.agentType, l.runId, l.peakMb]), [['dev-lead', 'run-1', 301], ['unknown', 'run-2', 400]]);
  });

  it('writes the store through the async atomic writer, never the sync one', async () => {
    seedRuns(3);
    const asyncWrites = [];
    const s = createJobMemoryStats({
      storePath: path.join(tmp, STORE_FILE),
      now: () => clock,
      writeTextAtomicSync: () => { throw new Error('sync write used'); },
      writeTextAtomic: async (f, text) => { asyncWrites.push(f); fs.writeFileSync(f, text); },
    });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 3);
    assert.deepEqual(asyncWrites, [path.join(tmp, STORE_FILE)]);
    assert.equal(storeLines().length, 3);
  });

  it('a live peak landing during the async write is kept', async () => {
    seedRuns(2);
    let s;
    s = createJobMemoryStats({
      storePath: path.join(tmp, STORE_FILE),
      now: () => clock,
      writeTextAtomic: async (f, text) => {
        // The live peak's sync write lands first, then our rename replaces the file.
        s.recordPeak({ agentType: 'validator', peakMb: 777, at: 9, runId: 'live-run', unit: 'sm-job-live' });
        await new Promise((r) => setImmediate(r));
        fs.writeFileSync(f, text);
      },
    });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 2);
    const lines = storeLines();
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => l.unit === 'sm-job-live' && l.peakMb === 777), JSON.stringify(lines));
  });

  it('a live peak already on disk after the async write is kept exactly once, whatever its key order', async () => {
    seedRuns(2);
    let s;
    s = createJobMemoryStats({
      storePath: path.join(tmp, STORE_FILE),
      now: () => clock,
      writeTextAtomic: async (f, text) => {
        s.recordPeak({ agentType: 'validator', peakMb: 777, at: 9, runId: 'live-run', unit: 'sm-job-live' });
        await new Promise((r) => setImmediate(r));
        // The live peak lands after our rename, written with its keys in a different order.
        fs.writeFileSync(f, text + JSON.stringify({ unit: 'sm-job-live', at: 9, runId: 'live-run', peakMb: 777, agentType: 'validator' }) + '\n');
      },
    });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 2);
    const lines = storeLines();
    assert.equal(lines.length, 3, JSON.stringify(lines));
    assert.equal(lines.filter((l) => l.runId === 'live-run' && l.unit === 'sm-job-live' && l.at === 9).length, 1);
  });

  it('a live peak replaced by the async write is re-appended exactly once', async () => {
    seedRuns(2);
    let s;
    s = createJobMemoryStats({
      storePath: path.join(tmp, STORE_FILE),
      now: () => clock,
      writeTextAtomic: async (f, text) => {
        s.recordPeak({ at: 9, unit: 'sm-job-live', peakMb: 777, runId: 'live-run', agentType: 'validator' });
        await new Promise((r) => setImmediate(r));
        fs.writeFileSync(f, text);
      },
    });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 2);
    const live = storeLines().filter((l) => l.runId === 'live-run' && l.unit === 'sm-job-live' && l.at === 9);
    assert.equal(live.length, 1);
    assert.equal(live[0].peakMb, 777);
  });

  it('a store holding 30 samples is left alone', async () => {
    seedRuns(5);
    writeStore(seq(30, (i) => ({ agentType: 'dev-lead', peakMb: 500, at: i })));
    const s = make();
    assert.equal(await s.backfillFromRunLogs(RUNS()), 0);
    assert.equal(storeLines().length, 30);
  });

  it('never throws on unreadable files', async () => {
    const p = writeLog('r1/a.log', '[scheduler] memory scope u1: peak=100MB\n', 1000);
    writeLog('r1/b.log', '[scheduler] memory scope u2: peak=200MB\n', 2000);
    const s = createJobMemoryStats({
      storePath: path.join(tmp, STORE_FILE),
      now: () => clock,
      fs: { ...fs, promises: { ...fs.promises, readFile: (f, ...a) => (f === p ? Promise.reject(new Error('EACCES')) : fs.promises.readFile(f, ...a)) } },
    });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 1);
  });

  it('reads at most 50 logs per batch and yields the event loop between batches', async () => {
    for (let i = 0; i < 120; i++) writeLog(`run-${String(i).padStart(3, '0')}/a.log`, peakLine(`u${i}`, 100 + i), 1000 + i);
    let inFlight = 0;
    let maxInFlight = 0;
    let immediates = 0;
    const batchMax = [];
    const counted = {
      ...fs,
      promises: {
        ...fs.promises,
        readFile: async (f, ...a) => {
          inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
          try { return await fs.promises.readFile(f, ...a); } finally { inFlight--; }
        },
      },
    };
    const realSetImmediate = global.setImmediate;
    global.setImmediate = (fn, ...a) => { immediates++; batchMax.push(maxInFlight); maxInFlight = 0; return realSetImmediate(fn, ...a); };
    try {
      const s = createJobMemoryStats({ storePath: path.join(tmp, STORE_FILE), now: () => clock, fs: counted });
      assert.equal(await s.backfillFromRunLogs(RUNS(), { maxFiles: 120 }), 120);
    } finally {
      global.setImmediate = realSetImmediate;
    }
    batchMax.push(maxInFlight);
    assert.ok(Math.max(...batchMax) <= BACKFILL_BATCH, `max in flight ${Math.max(...batchMax)}`);
    assert.ok(immediates >= 2, `yields=${immediates}`); // 120 files → 3 batches → 2 yields
    assert.equal(storeLines()[0].peakMb, 100); // oldest first
  });

  it('never uses a synchronous fs call to read run logs', async () => {
    seedRuns(3);
    const sync = [];
    const guarded = {
      ...fs,
      readdirSync: (...a) => { sync.push(['readdirSync', a[0]]); return fs.readdirSync(...a); },
      statSync: (...a) => { sync.push(['statSync', a[0]]); return fs.statSync(...a); },
      readFileSync: (f, ...a) => { if (String(f).endsWith('.log')) sync.push(['readFileSync', f]); return fs.readFileSync(f, ...a); },
    };
    const s = createJobMemoryStats({ storePath: path.join(tmp, STORE_FILE), now: () => clock, fs: guarded });
    assert.equal(await s.backfillFromRunLogs(RUNS()), 3);
    assert.deepEqual(sync, []);
  });
});

describe('deferred scheduler backfill (scheduleMemoryBackfill)', () => {
  const scheduler = require('../../../scheduler.cjs');
  const RUNS = () => path.join(tmp, 'runs');
  const storeFile = () => path.join(tmp, STORE_FILE);
  function seedRuns(n) {
    for (let i = 0; i < n; i++) {
      const p = path.join(RUNS(), `2026-11-${String(10 + i).padStart(2, '0')}T00-00-00-000Z`, `job-${i}.log`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `[scheduler] memory scope sm-job-${i}: peak=${100 + i}MB oom_kill=0\n`);
    }
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { scheduler.cancelMemoryBackfill(); vi.useRealTimers(); });

  it('boot does no backfill; the pass runs once ~60 s later on an unref\'d timer and seeds the store', async () => {
    seedRuns(5);
    const stats = make();
    const backfillFromRunLogs = vi.fn(stats.backfillFromRunLogs);
    const done = scheduler.scheduleMemoryBackfill({ runsDir: RUNS(), backfillFromRunLogs });
    assert.equal(scheduler.MEMORY_BACKFILL_DELAY_MS, 60_000);
    // A second schedule while pending is the same pass.
    assert.equal(scheduler.scheduleMemoryBackfill({ runsDir: RUNS(), backfillFromRunLogs }), done);
    assert.equal(backfillFromRunLogs.mock.calls.length, 0);
    assert.equal(fs.existsSync(storeFile()), false);
    vi.advanceTimersByTime(59_999);
    assert.equal(backfillFromRunLogs.mock.calls.length, 0);
    assert.equal(fs.existsSync(storeFile()), false);
    vi.advanceTimersByTime(1);
    assert.equal(await done, 5);
    assert.equal(backfillFromRunLogs.mock.calls.length, 1);
    assert.deepEqual(backfillFromRunLogs.mock.calls[0][1], { maxFiles: 500 });
    stats._resetCache();
    assert.deepEqual(stats.loadSamples().map((s) => s.peakMb), [100, 101, 102, 103, 104]);
  });

  it('the timer is unref\'d so it never holds the process open', () => {
    const realSetTimeout = setTimeout;
    let unrefd = false;
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      const t = realSetTimeout(fn, ms);
      const orig = t.unref?.bind(t);
      t.unref = () => { unrefd = true; return orig ? orig() : t; };
      return t;
    });
    try {
      scheduler.scheduleMemoryBackfill({ runsDir: RUNS(), backfillFromRunLogs: async () => 0 });
    } finally { spy.mockRestore(); }
    assert.equal(unrefd, true);
  });

  it('a second pass with 30 or more samples does nothing', async () => {
    seedRuns(5);
    writeStore(seq(30, (i) => ({ agentType: 'dev-lead', peakMb: 500, at: i })));
    const before = fs.readFileSync(storeFile(), 'utf8');
    const stats = make();
    const done = scheduler.scheduleMemoryBackfill({ runsDir: RUNS(), backfillFromRunLogs: stats.backfillFromRunLogs });
    vi.advanceTimersByTime(60_000);
    assert.equal(await done, 0);
    assert.equal(fs.readFileSync(storeFile(), 'utf8'), before);
  });

  it('a seeded store reaching 30 makes the next pass a no-op', async () => {
    seedRuns(30);
    const stats = make();
    let done = scheduler.scheduleMemoryBackfill({ runsDir: RUNS(), backfillFromRunLogs: stats.backfillFromRunLogs });
    vi.advanceTimersByTime(60_000);
    assert.equal(await done, 30);
    const before = fs.readFileSync(storeFile(), 'utf8');
    seedRuns(31); // a new run appears
    done = scheduler.scheduleMemoryBackfill({ runsDir: RUNS(), backfillFromRunLogs: stats.backfillFromRunLogs });
    vi.advanceTimersByTime(60_000);
    assert.equal(await done, 0);
    assert.equal(fs.readFileSync(storeFile(), 'utf8'), before);
  });
});
