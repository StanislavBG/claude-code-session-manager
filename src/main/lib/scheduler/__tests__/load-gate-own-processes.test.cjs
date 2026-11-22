'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/load-gate-own-processes.test.cjs
//
// PRD 3495 — 2026-11-22 the load gate held launches at loadavg ratios 2.21 …
// 1.01 on 14 cores while the app's own renderer averaged ~81% CPU and main
// ~45%. The gate's busy measure must be net of the app's own process tree
// (main + Electron --type= helpers), and the decision must use the net value.
const assert = require('node:assert/strict');
const { parsePidStat, readOwnProcessTicks, createCpuSampler } = require('../cpuSample.cjs');
const { createLoadGate } = require('../loadGate.cjs');

// ─── /proc/<pid>/stat parsing ───────────────────────────────────────────────

test('parsePidStat reads ppid and utime+stime, tolerating spaces and parens in comm', () => {
  const line = '4242 (Web Content (x) y) S 100 4242 4242 0 -1 4194560 1 0 0 0 700 300 0 0 20 0 1 0 1 1 1';
  assert.deepEqual(parsePidStat(line), { pid: 4242, ppid: 100, ticks: 1000 });
  assert.equal(parsePidStat('garbage'), null);
  assert.equal(parsePidStat(''), null);
});

// ─── own-process tree discovery ─────────────────────────────────────────────

function fakeProc(procs) {
  // procs: { pid: { ppid, ticks, cmd } }
  const files = {};
  for (const [pid, p] of Object.entries(procs)) {
    files[`/proc/${pid}/stat`] = `${pid} (x) S ${p.ppid} 1 1 0 -1 0 0 0 0 0 ${p.ticks} 0 0 0 20 0 1 0 1 1 1`;
    // Chromium helpers rewrite argv as ONE space-joined string; others are NUL-separated.
    files[`/proc/${pid}/cmdline`] = p.cmd.includes('--type=') ? `${p.cmd}\0` : p.cmd.split(' ').join('\0');
    files[`/proc/${pid}/exe`] = p.exe || (p.cmd.startsWith('/opt/electron') ? '/opt/electron' : `/usr/bin/${p.cmd.split(' ')[0]}`);
  }
  return {
    readdir: () => [...Object.keys(procs), 'self', 'stat'],
    readFile: (f) => {
      if (!(f in files)) throw new Error('ENOENT');
      return files[f];
    },
    readlink: (f) => {
      if (!(f in files)) throw new Error('ENOENT');
      return files[f];
    },
  };
}

test('readOwnProcessTicks counts main plus --type= helpers (incl. zygote children), not spawned jobs', () => {
  const proc = fakeProc({
    100: { ppid: 1, ticks: 450, cmd: '/opt/electron .' },
    101: { ppid: 100, ticks: 30, cmd: '/opt/electron --type=gpu-process' },
    102: { ppid: 100, ticks: 0, cmd: '/opt/electron --type=zygote' },
    103: { ppid: 102, ticks: 810, cmd: '/opt/electron --type=renderer' },
    104: { ppid: 100, ticks: 5000, cmd: 'claude -p --model opus' }, // a job: NOT own
    107: { ppid: 100, ticks: 777, cmd: 'sm-claude-job --type=renderer prompt text' }, // other exe: NOT own
    105: { ppid: 104, ticks: 9000, cmd: 'node vitest' }, // job child: NOT own
    106: { ppid: 100, ticks: 12, cmd: '/opt/electron --type=utility --utility-sub-type=network' },
    200: { ppid: 1, ticks: 99999, cmd: 'firefox' },
  });
  const own = readOwnProcessTicks({ rootPid: 100, platform: 'linux', ...proc });
  assert.deepEqual([...own.keys()].sort(), [100, 101, 102, 103, 106]);
  assert.equal([...own.values()].reduce((a, b) => a + b, 0), 450 + 30 + 810 + 12);
});

test('readOwnProcessTicks is null off Linux and on read failure', () => {
  assert.equal(readOwnProcessTicks({ platform: 'darwin' }), null);
  assert.equal(readOwnProcessTicks({ platform: 'linux', rootPid: 1, readdir: () => { throw new Error('x'); } }), null);
});

// ─── net computation in the sampler ─────────────────────────────────────────

function samplerWith(steps) {
  let t = 0;
  let i = 0;
  const s = createCpuSampler({
    now: () => t,
    read: () => steps[i].stat,
    readOwn: () => steps[i].own,
  });
  return {
    s,
    step(ms) { t += ms; i += 1; },
  };
}

test('sampler reports raw busy and busy net of own-process ticks', () => {
  // 14 cores × 60 s × 100 Hz = 84000 total ticks. Machine busy 60%, app 1.26 cores (~9%).
  const { s, step } = samplerWith([
    { stat: { busy: 0, iowait: 0, total: 0 }, own: new Map([[100, 0], [103, 0]]) },
    { stat: { busy: 50400, iowait: 0, total: 84000 }, own: new Map([[100, 2700], [103, 4860]]) },
  ]);
  s.observe();
  step(60_000);
  const r = s.sample();
  assert.equal(r.busyFraction, 0.6);
  assert.equal(Number(r.ownFraction.toFixed(4)), Number((7560 / 84000).toFixed(4)));
  assert.equal(Number(r.netBusyFraction.toFixed(4)), Number(((50400 - 7560) / 84000).toFixed(4)));
});

test('a pid that exited or appeared mid-window does not produce a negative or inflated own delta', () => {
  const { s, step } = samplerWith([
    { stat: { busy: 0, iowait: 0, total: 0 }, own: new Map([[100, 1000], [999, 5000]]) },
    // 999 gone; 103 new (counted from its full ticks since it started inside the window)
    { stat: { busy: 30000, iowait: 0, total: 84000 }, own: new Map([[100, 2000], [103, 600]]) },
  ]);
  s.observe();
  step(60_000);
  const r = s.sample();
  assert.equal(r.ownFraction, (1000 + 600) / 84000);
  assert.equal(r.netBusyFraction, (30000 - 1600) / 84000);
});

test('own delta is clamped to machine busy (net never below 0)', () => {
  const { s, step } = samplerWith([
    { stat: { busy: 0, iowait: 0, total: 0 }, own: new Map([[100, 0]]) },
    { stat: { busy: 100, iowait: 0, total: 84000 }, own: new Map([[100, 500]]) },
  ]);
  s.observe();
  step(60_000);
  assert.equal(s.sample().netBusyFraction, 0);
});

test('no own reading → net equals raw', () => {
  const { s, step } = samplerWith([
    { stat: { busy: 0, iowait: 0, total: 0 }, own: null },
    { stat: { busy: 42000, iowait: 0, total: 84000 }, own: null },
  ]);
  s.observe();
  step(60_000);
  const r = s.sample();
  assert.equal(r.netBusyFraction, 0.5);
  assert.equal(r.ownFraction, null);
});

// ─── decision uses net ──────────────────────────────────────────────────────

const cpuAt = (raw, net, own = raw - net) => ({
  observe() {},
  sample: () => ({ busyFraction: raw, netBusyFraction: net, ownFraction: own, iowaitFraction: 0, windowMs: 60_000 }),
});
const gate = (cpu, l1 = 30.94) => createLoadGate({ loadavg: () => [l1, 0, 0], cores: () => 14, threshold: 0.85, now: () => 0, platform: 'linux', cpu });

test('2026-11-22 shape: ratio 2.21, raw 62% busy, app-net 40% → stands down (app no longer gates on itself)', () => {
  const r = gate(cpuAt(0.62, 0.40)).evaluate();
  assert.equal(r.ratio, 2.21);
  assert.equal(r.gated, false);
  assert.equal(r.standDown, true);
  assert.equal(r.shouldAuditStandDown, true);
  assert.equal(r.cpuBusyRaw, 0.62);
  assert.equal(r.cpuBusyNet, 0.4);
  assert.equal(r.cpuBusy, 0.4);
  assert.equal(r.cpuOwnBusy, 0.22);
});

test('net busy over the idle bar still holds and reports raw + net', () => {
  const r = gate(cpuAt(0.9, 0.7)).evaluate();
  assert.equal(r.gated, true);
  assert.equal(r.shouldAudit, true);
  assert.equal(r.cpuBusyRaw, 0.9);
  assert.equal(r.cpuBusyNet, 0.7);
});

test('saturation is judged on net: raw 0.95 / net 0.6 is not saturated', () => {
  const g = gate(cpuAt(0.95, 0.6));
  assert.equal(g.evaluate().saturated, false);
  assert.equal(g.isSaturated(), false);
  assert.equal(gate(cpuAt(0.97, 0.9)).isSaturated(), true);
});

test('loadavg under threshold never gates whatever the CPU', () => {
  const r = gate(cpuAt(0.99, 0.99), 5).evaluate();
  assert.equal(r.gated, false);
  assert.equal(r.standDown, false);
});

test('a legacy sample without netBusyFraction falls back to raw', () => {
  const cpu = { observe() {}, sample: () => ({ busyFraction: 0.3, iowaitFraction: 0, windowMs: 60_000 }) };
  const r = gate(cpu).evaluate();
  assert.equal(r.standDown, true);
  assert.equal(r.cpuBusyRaw, 0.3);
  assert.equal(r.cpuBusyNet, 0.3);
  assert.equal(r.cpuOwnBusy, null);
});
