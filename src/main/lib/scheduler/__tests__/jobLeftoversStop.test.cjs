'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { scanJobProcesses, selectLeftovers, stopLeftovers } = require('../jobLeftovers.cjs');

// Unit: SIGKILL gating with injected deps.
describe('stopLeftovers (injected)', () => {
  it('SIGTERMs, then SIGKILLs only complete same-identity pids; gone pids never throw', () => {
    const sent = [];
    let timerFn;
    const kill = (pid, sig) => { sent.push([pid, sig]); if (pid === 13) throw new Error('ESRCH'); };
    const rec = { 11: { complete: true, startTicks: 1 }, 12: { complete: true, startTicks: 2 }, 13: { complete: true, startTicks: 3 }, 14: { complete: true, startTicks: 4 } };
    let phase = 0;
    const identityOf = (pid) => {
      if (phase === 0) return rec[pid];
      if (pid === 11) return rec[11];
      if (pid === 12) return { complete: true, startTicks: 99 }; // recycled
      return { complete: false }; // 4: unreadable
    };
    const isDifferentProcess = (a, b) => a.complete && b.complete && a.startTicks !== b.startTicks;
    const out = stopLeftovers([{ pid: 11 }, { pid: 12 }, { pid: 13 }, { pid: 14 }], {
      kill, identityOf, isDifferentProcess, graceMs: 5000,
      setTimer: (fn, ms) => { assert.equal(ms, 5000); timerFn = fn; return { unref() {} }; },
    });
    assert.deepEqual(out, [11, 12, 14]);
    phase = 1;
    timerFn();
    assert.deepEqual(sent.filter(([, s]) => s === 'SIGKILL'), [[11, 'SIGKILL']]);
  });
});

const isLinux = process.platform === 'linux';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!isLinux)('stopLeftovers (real processes)', () => {
  const slug = `leftover-test-${process.pid}-${Date.now()}`;
  const filtered = () => {
    const s = scanJobProcesses();
    return { procs: s.procs.filter((p) => p.slug === slug), parentOf: s.parentOf };
  };

  async function startOrphan() {
    const sh = spawn('sh', ['-c', 'setsid sleep 120 & exit 0'], {
      env: { ...process.env, SM_SCHEDULER_JOB_SLUG: slug }, stdio: 'ignore',
    });
    await new Promise((r) => sh.on('exit', r));
    for (let i = 0; i < 30; i++) {
      const hit = filtered().procs.find((p) => p.ppid !== sh.pid && p.comm === 'sleep');
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error('orphan never appeared');
  }

  afterEach(() => {
    for (const p of filtered().procs) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
  });

  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async (pid) => { for (let i = 0; i < 30 && alive(pid); i++) await sleep(100); };

  it('stops the orphan when its row ended', async () => {
    const orphan = await startOrphan();
    const now = Date.now();
    const rows = [{ slug, status: 'completed', finishedAt: new Date(now - 3_600_000).toISOString() }];
    const sel = selectLeftovers({ scan: filtered(), rows, runningSlugs: new Set(), now, selfPid: process.pid });
    assert.equal(sel.length, 1);
    stopLeftovers(sel[0].procs);
    await waitDead(orphan.pid);
    assert.equal(alive(orphan.pid) && filtered().procs.some((p) => p.pid === orphan.pid), false);
  });

  it('leaves the orphan alive when its row is running', async () => {
    const orphan = await startOrphan();
    const rows = [{ slug, status: 'running' }];
    const sel = selectLeftovers({ scan: filtered(), rows, runningSlugs: new Set([slug]), now: Date.now(), selfPid: process.pid });
    assert.equal(sel.length, 0);
    assert.equal(alive(orphan.pid), true);
  });
});
