'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanJobProcesses, selectLeftovers, LEFTOVER_GRACE_MS } = require('../jobLeftovers.cjs');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobleft-'));
  fs.writeFileSync(path.join(root, 'uptime'), '1000.00 5.00\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function addProc(pid, { ppid = 1, state = 'S', tty = 0, comm = 'node', slug, argv = ['node', 'x.js'], cwd = '/tmp', start = 10000, utime = 100, stime = 100 } = {}) {
  const d = path.join(root, String(pid));
  fs.mkdirSync(d);
  const rest = Array(20).fill('0');
  rest[0] = state; rest[1] = String(ppid); rest[4] = String(tty);
  rest[11] = String(utime); rest[12] = String(stime); rest[19] = String(start);
  fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) ${rest.join(' ')}\n`);
  if (slug !== undefined) fs.writeFileSync(path.join(d, 'environ'), `A=1\0SM_SCHEDULER_JOB_SLUG=${slug}\0`);
  else fs.writeFileSync(path.join(d, 'environ'), 'A=1\0');
  fs.writeFileSync(path.join(d, 'cmdline'), argv.join('\0') + '\0');
  fs.symlinkSync(cwd, path.join(d, 'cwd'));
}

describe('scanJobProcesses', () => {
  it('returns empty on non-linux or unreadable root', () => {
    const a = scanJobProcesses({ procRoot: root, platform: 'darwin' });
    assert.deepEqual(a.procs, []); assert.equal(a.parentOf.size, 0);
    const b = scanJobProcesses({ procRoot: path.join(root, 'nope'), platform: 'linux' });
    assert.deepEqual(b.procs, []); assert.equal(b.parentOf.size, 0);
  });

  it('collects marked live procs and maps every ppid', () => {
    addProc(10, { ppid: 1, slug: 's1', comm: 'we (ird) x', start: 50000 });
    addProc(11, { ppid: 10 });
    addProc(12, { ppid: 1, slug: 's1', state: 'Z' });
    fs.mkdirSync(path.join(root, '13')); // unreadable stat
    fs.mkdirSync(path.join(root, 'self'));
    const { procs, parentOf } = scanJobProcesses({ procRoot: root, platform: 'linux' });
    assert.equal(parentOf.get(11), 10);
    assert.equal(parentOf.get(12), 1);
    assert.equal(parentOf.has(13), false);
    assert.equal(procs.length, 1);
    const p = procs[0];
    assert.equal(p.pid, 10); assert.equal(p.slug, 's1'); assert.equal(p.comm, 'we (ird) x');
    assert.deepEqual(p.argv, ['node', 'x.js']); assert.equal(p.cwd, '/tmp');
    assert.equal(p.startTicks, 50000); assert.equal(p.etimes, 500);
    assert.equal(p.pcpu, (2 / 500) * 100);
  });

  it('skips a pid whose environ is unreadable without throwing', () => {
    addProc(20, { slug: 's' });
    fs.rmSync(path.join(root, '20', 'environ'));
    const r = scanJobProcesses({ procRoot: root, platform: 'linux' });
    assert.deepEqual(r.procs, []);
    assert.equal(r.parentOf.get(20), 1);
  });
});

describe('selectLeftovers', () => {
  const now = 10_000_000;
  const old = new Date(now - LEFTOVER_GRACE_MS - 1000).toISOString();
  const mk = (pid, extra = {}) => ({ pid, ppid: 1, tty: 0, slug: 's', argv: ['node'], cwd: '/tmp', comm: 'node', startTicks: 1, etimes: 1, pcpu: 0, ...extra });
  const sel = (o) => selectLeftovers({ scan: { procs: [mk(100)], parentOf: new Map([[100, 1]]) }, rows: [{ slug: 's', status: 'completed', finishedAt: old }], runningSlugs: new Set(), now, selfPid: 5, ...o });

  it('returns an ended slug', () => {
    const r = sel({});
    assert.equal(r.length, 1); assert.equal(r[0].slug, 's'); assert.equal(r[0].procs[0].pid, 100);
  });
  it('no row at all counts as ended; ended statuses count', () => {
    assert.equal(sel({ rows: [] }).length, 1);
    for (const status of ['needs_review', 'failed', 'completed', 'skipped']) {
      assert.equal(sel({ rows: [{ slug: 's', status, finishedAt: old }] }).length, 1, status);
    }
  });
  it('skips live statuses and runningSlugs, even when another row ended', () => {
    for (const status of ['running', 'investigating', 'pending']) {
      assert.equal(sel({ rows: [{ slug: 's', status }, { slug: 's', status: 'completed', finishedAt: old }] }).length, 0, status);
    }
    assert.equal(sel({ runningSlugs: new Set(['s']) }).length, 0);
  });
  it('respects the grace period and leaves rows without any time alone', () => {
    const fresh = new Date(now - 1000).toISOString();
    assert.equal(sel({ rows: [{ slug: 's', status: 'failed', finishedAt: fresh }] }).length, 0);
    assert.equal(sel({ rows: [{ slug: 's', status: 'failed' }] }).length, 0);
    assert.equal(sel({ rows: [{ slug: 's', status: 'failed', statusHistory: [{ status: 'failed', at: old }] }] }).length, 1);
    assert.equal(sel({ rows: [{ slug: 's', status: 'failed', statusHistory: [{ status: 'failed', at: new Date(now).toISOString() }] }] }).length, 0);
  });
  it('skips a slug with a claude process', () => {
    const scan = { procs: [mk(100), mk(101, { argv: ['/usr/bin/claude', '-p'] })], parentOf: new Map() };
    assert.equal(sel({ scan }).length, 0);
  });
  it('drops tty, self, ancestors and descendants; empty slug not returned', () => {
    const parentOf = new Map([[5, 4], [4, 3], [3, 1], [6, 5], [7, 6], [100, 1]]);
    const procs = [mk(100), mk(101, { tty: 34816 }), mk(5), mk(4), mk(3), mk(6), mk(7)];
    const r = sel({ scan: { procs, parentOf } });
    assert.deepEqual(r[0].procs.map((p) => p.pid), [100]);
    const only = sel({ scan: { procs: [mk(5), mk(6)], parentOf } });
    assert.deepEqual(only, []);
  });
});
