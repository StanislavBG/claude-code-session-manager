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
  parsePidStatFields,
  readProcessTicks,
  idleNiceTicksDelta,
  MAX_PROC_SCAN,
} = require('../cpuSample.cjs');
const { createLoadGate, formatLoadGateDetail, SATURATED_BUSY } = require('../loadGate.cjs');

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
    assert.deepEqual(parseProcStat(FIXTURE), { busy: total - 3435389467 - 42421499, iowait: 42421499, total });
  });
  it('ignores guest columns', () => {
    assert.deepEqual(parseProcStat('cpu 1 2 3 4 5 6 7 8 900 900\n'), { busy: 27, iowait: 5, total: 36 });
  });
  it('treats missing trailing columns as 0', () => {
    assert.deepEqual(parseProcStat('cpu 1 2 3 4\n'), { busy: 6, iowait: 0, total: 10 });
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
    assert.deepEqual(r, { busy: 6, iowait: 0, total: 10 });
  });
  it('sums os.cpus() elsewhere', () => {
    const cpus = () => [
      { times: { user: 1, nice: 2, sys: 3, idle: 10, irq: 4 } },
      { times: { user: 1, nice: 0, sys: 1, idle: 20, irq: 0 } },
    ];
    assert.deepEqual(readCpuTimes({ platform: 'win32', cpus }), { busy: 12, iowait: 0, total: 42 });
  });
  it('returns null on throw or empty cpu list', () => {
    assert.equal(readCpuTimes({ platform: 'linux', readFile: () => { throw new Error('x'); } }), null);
    assert.equal(readCpuTimes({ platform: 'darwin', cpus: () => [] }), null);
    assert.equal(readCpuTimes({ platform: 'darwin', cpus: () => { throw new Error('x'); } }), null);
  });
  it.runIf(process.platform === 'linux')('reads the real /proc/stat', () => {
    const r = readCpuTimes();
    assert.ok(r.busy >= 0 && r.busy <= r.total);
  });
});

// No own-process reading injected → net equals raw, own share unknown (PRD 3495).
const noOwn = (b) => ({ busyFraction: b, ownFraction: null, idleNiceShare: null, netBusyFraction: b });

function harness() {
  let t = 1_000_000;
  let cur = { busy: 0, total: 0 };
  const s = createCpuSampler({ now: () => t, read: () => cur, readOwn: () => null });
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
    assert.deepEqual(h.s.sample(), { ...noOwn(0.25), iowaitFraction: 0, windowMs: 61_000 });
  });

  it('picks the stored reading closest to windowMs among 30/60/90 s', () => {
    const h = harness();
    h.at(0, { busy: 0, total: 0 }); h.s.observe();      // age 90 at sample
    h.at(30_000, { busy: 10, total: 100 }); h.s.observe(); // age 60
    h.at(60_000, { busy: 20, total: 200 }); h.s.observe(); // age 30
    h.at(90_000, { busy: 70, total: 300 });
    assert.deepEqual(h.s.sample(), { ...noOwn(0.3), iowaitFraction: 0, windowMs: 60_000 });
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
    assert.deepEqual(h.s.sample(), { ...noOwn(2 / 20), iowaitFraction: 0, windowMs: 100_000 });
    h.at(400_000, { busy: 9, total: 90 });
    assert.equal(h.s.sample(), null);
  });

  it('includes boundary ages inclusively', () => {
    const h = harness();
    h.at(0, { busy: 0, total: 0 }); h.s.observe();
    h.at(MIN_WINDOW_MS, { busy: 1, total: 4 });
    assert.deepEqual(h.s.sample(), { ...noOwn(0.25), iowaitFraction: 0, windowMs: MIN_WINDOW_MS });
    h.at(MAX_WINDOW_MS, { busy: 1, total: 4 });
    assert.deepEqual(h.s.sample(), { ...noOwn(0.25), iowaitFraction: 0, windowMs: MAX_WINDOW_MS });
  });

  it('reports iowaitFraction over the total delta, clamped, backwards gives 0', () => {
    const h = harness();
    h.at(0, { busy: 0, iowait: 50, total: 0 }); h.s.observe();
    h.at(60_000, { busy: 10, iowait: 80, total: 100 });
    assert.deepEqual(h.s.sample(), { ...noOwn(0.1), iowaitFraction: 0.3, windowMs: 60_000 });
    h.at(60_000, { busy: 10, iowait: 20, total: 100 });
    assert.deepEqual(h.s.sample(), { ...noOwn(0.1), iowaitFraction: 0, windowMs: 60_000 });
    h.at(60_000, { busy: 10, iowait: 500, total: 100 });
    assert.equal(h.s.sample().iowaitFraction, 1);
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

// ─── idle-priority (nice 19) exclusion, PRD 4021 ────────────────────────────
// 2026-11-23 6:20 PM PST: two voice renders (Chatterbox at nice 12, Ming TTS at
// nice 19) used ~13.5 of 14 cores and the gate held all 163 pending jobs.

// /proc/<pid>/stat with field 19 (nice) set; field 18 (priority) = 20 + nice.
const statLine = (pid, ppid, ticks, nice, comm = 'x') =>
  `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 ${20 + nice} ${nice} 1 0 1 1 1`;

function fakeProcFs(procs) {
  // procs: { pid: { ppid, ticks, nice, cmd } }
  const files = {};
  for (const [pid, p] of Object.entries(procs)) {
    files[`/proc/${pid}/stat`] = statLine(pid, p.ppid, p.ticks, p.nice);
    files[`/proc/${pid}/cmdline`] = p.cmd.includes('--type=') ? `${p.cmd}\0` : p.cmd.split(' ').join('\0');
    files[`/proc/${pid}/exe`] = p.cmd.startsWith('/opt/electron') ? '/opt/electron' : `/usr/bin/${p.cmd.split(' ')[0]}`;
  }
  const get = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; };
  return { readdir: () => [...Object.keys(procs), 'self', 'stat'], readFile: get, readlink: get };
}

describe('parsePidStatFields', () => {
  it('reads nice from field 19, tolerating parens in comm', () => {
    assert.deepEqual(parsePidStatFields(statLine(7, 1, 500, 19, 'ming (tts) w')), { pid: 7, ppid: 1, ticks: 500, nice: 19 });
    assert.equal(parsePidStatFields(statLine(8, 1, 5, -5)).nice, -5);
  });
  it('nice is null on a truncated line', () => {
    assert.equal(parsePidStatFields('9 (x) S 1 1 1 0 -1 0 0 0 0 0 5 0').nice, null);
  });
});

describe('readProcessTicks', () => {
  const tree = {
    100: { ppid: 1, ticks: 450, nice: 12, cmd: '/opt/electron .' },
    101: { ppid: 100, ticks: 30, nice: 19, cmd: '/opt/electron --type=renderer' }, // own at nice 19: own only
    300: { ppid: 1, ticks: 9000, nice: 12, cmd: 'python chatterbox' },
    301: { ppid: 1, ticks: 8000, nice: 19, cmd: 'python ming-tts' },
    302: { ppid: 1, ticks: 10, nice: 0, cmd: 'bash' },
  };
  it('one scan gives the own tree and non-own nice-19 processes', () => {
    const r = readProcessTicks({ rootPid: 100, platform: 'linux', ...fakeProcFs(tree) });
    assert.deepEqual([...r.own.keys()].sort(), [100, 101]);
    assert.deepEqual([...r.idleNice.entries()], [[301, 8000]]);
  });
  it('idleNice still reads when the root is missing; both null off Linux or on failure', () => {
    const r = readProcessTicks({ rootPid: 4242, platform: 'linux', ...fakeProcFs(tree) });
    assert.equal(r.own, null);
    assert.deepEqual([...r.idleNice.keys()].sort(), [101, 301]);
    assert.deepEqual(readProcessTicks({ platform: 'darwin' }), { own: null, idleNice: null });
    assert.deepEqual(readProcessTicks({ platform: 'linux', readdir: () => { throw new Error('x'); } }), { own: null, idleNice: null });
  });
  it('reads at most maxPids pids (default MAX_PROC_SCAN)', () => {
    assert.ok(MAX_PROC_SCAN > 0 && MAX_PROC_SCAN <= 8192);
    let reads = 0;
    const fs2 = fakeProcFs(tree);
    const r = readProcessTicks({ rootPid: 100, platform: 'linux', maxPids: 2, readdir: fs2.readdir, readlink: fs2.readlink,
      readFile: (f) => { if (f.endsWith('/stat')) reads++; return fs2.readFile(f); } });
    assert.equal(reads, 2);
    assert.equal(r.idleNice.size, 0);
  });
});

describe('idleNiceTicksDelta', () => {
  it('counts only pids at nice 19 in both readings', () => {
    assert.equal(idleNiceTicksDelta(new Map([[1, 100], [2, 50]]), new Map([[1, 400], [3, 99999]])), 300);
    assert.equal(idleNiceTicksDelta(null, new Map()), null);
  });
});

describe('sampler nets out nice-19 ticks (injected /proc readers)', () => {
  // 14 cores x 60 s x 100 Hz = 84000 ticks; 94% busy = 78960 ticks.
  const TOTAL = 84000;
  const BUSY = 78960;
  function run(renderNice) {
    let t = 0;
    let busy = 0;
    let total = 0;
    let renderTicks = 0;
    const procs = () => ({
      100: { ppid: 1, ticks: 0, nice: 12, cmd: '/opt/electron .' },
      300: { ppid: 1, ticks: renderTicks, nice: renderNice, cmd: 'python tts-render' },
      301: { ppid: 1, ticks: renderTicks ? BUSY * 0.4 : 0, nice: 12, cmd: 'python other' },
    });
    const s = createCpuSampler({
      now: () => t,
      read: () => ({ busy, iowait: 0, total }),
      readProcs: () => readProcessTicks({ rootPid: 100, platform: 'linux', ...fakeProcFs(procs()) }),
    });
    s.observe();
    t = 60_000;
    busy = BUSY;
    total = TOTAL;
    renderTicks = BUSY * 0.6; // 60% of the busy time is the render
    return s.sample();
  }
  const gateOn = (sample) => createLoadGate({
    loadavg: () => [23.77, 0, 0], cores: () => 14, threshold: 0.85, now: () => 0, platform: 'linux',
    cpu: { observe() {}, sample: () => sample },
  }).evaluate();

  it('94% busy with 60% of it at nice 19 reads below the saturated band', () => {
    const r = run(19);
    assert.equal(r.busyFraction, 0.94);
    assert.equal(Number(r.idleNiceShare.toFixed(3)), 0.564);
    assert.equal(Number(r.netBusyFraction.toFixed(3)), 0.376);
    assert.ok(r.netBusyFraction < SATURATED_BUSY);
    const g = gateOn(r);
    assert.equal(g.saturated, false);
    assert.equal(g.cpuBusy, 0.376);
    assert.equal(g.cpuBusyRaw, 0.94);
    assert.equal(g.cpuIdleNice, 0.564);
  });

  it('the same render at nice 12 still reads saturated', () => {
    const r = run(12);
    assert.equal(r.idleNiceShare, 0);
    assert.equal(r.netBusyFraction, 0.94);
    assert.ok(r.netBusyFraction >= SATURATED_BUSY);
    const g = gateOn(r);
    assert.equal(g.saturated, true);
    assert.equal(g.gated, true);
    assert.equal(g.cpuIdleNice, 0);
  });

  it('nice-19 delta is clamped so net never goes below 0', () => {
    let t = 0;
    let cur = { busy: 0, total: 0 };
    let idle = new Map([[5, 0]]);
    const s = createCpuSampler({ now: () => t, read: () => cur, readIdleNice: () => idle });
    s.observe();
    t = 60_000; cur = { busy: 100, total: 84000 }; idle = new Map([[5, 900]]);
    const r = s.sample();
    assert.equal(r.netBusyFraction, 0);
    assert.equal(r.idleNiceShare, 100 / 84000);
    assert.equal(r.ownFraction, null);
  });
});

describe('formatLoadGateDetail names the idle-priority share', () => {
  const base = { loadavg1: 23.77, cores: 14, ratio: 1.698, threshold: 0.85, heldMs: 60_000, cpuBusy: 0.376, cpuWindowMs: 55_000 };
  it('when above 0', () => {
    const d = formatLoadGateDetail({ ...base, cpuIdleNice: 0.564 });
    assert.match(d, /CPU 38% busy over 55s \(excl\. 56% at nice 19\)/);
    assert.ok(d.length < 200);
  });
  it('not when 0 or unknown', () => {
    assert.doesNotMatch(formatLoadGateDetail({ ...base, cpuIdleNice: 0 }), /nice 19/);
    assert.doesNotMatch(formatLoadGateDetail({ ...base, cpuIdleNice: null }), /nice 19/);
  });
});
