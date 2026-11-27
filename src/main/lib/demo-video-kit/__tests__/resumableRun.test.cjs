/**
 * resumableRun.test.cjs — detached kit step: attach by key, wait in slices, lease expiry.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/resumableRun.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MOD = path.join(__dirname, '..', 'resumableRun.cjs');
const { startOrAttach, waitForResult, writeResult, stopRun, readLogTail, winTreeKillArgv, DEFAULT_LEASE_MS } = require(MOD);

const posix = test.skipIf(process.platform === 'win32');
const dirs = [];
const extraPids = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    stopRun(d);
    fs.rmSync(d, { recursive: true, force: true });
  }
  while (extraPids.length) try { process.kill(extraPids.pop(), 'SIGKILL'); } catch { /* gone */ }
});

function tmpDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-resumable-'));
  dirs.push(root);
  return { root, stateDir: path.join(root, 'state') };
}

/** Write a node step script; it gets RR_STATE / RR_KEY / RR_MARK from argv. */
function stepScript(root, name, body) {
  const file = path.join(root, `${name}.cjs`);
  fs.writeFileSync(file, `'use strict';\nconst fs = require('node:fs');\nconst rr = require(${JSON.stringify(MOD)});\nconst [stateDir, key, mark] = process.argv.slice(2);\n${body}\n`);
  return file;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function waitDead(pid, ms = 5000) {
  const t = Date.now();
  while (alive(pid) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
}
async function waitFile(file, ms = 5000) {
  const t = Date.now();
  while (!fs.existsSync(file) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25));
  return fs.existsSync(file);
}

test('DEFAULT_LEASE_MS is 20 minutes', () => {
  expect(DEFAULT_LEASE_MS).toBe(20 * 60 * 1000);
});

test('requiring the module spawns nothing', () => {
  const code = `
    const cp = require('node:child_process');
    let n = 0;
    for (const k of ['spawn', 'spawnSync', 'fork', 'exec', 'execFile', 'execSync', 'execFileSync']) {
      const orig = cp[k]; cp[k] = (...a) => { n++; return orig(...a); };
    }
    require(${JSON.stringify(MOD)});
    setTimeout(() => { process.stdout.write(String(n)); }, 100);
  `;
  const out = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10000 });
  expect(out.status).toBe(0);
  expect(out.stdout).toBe('0');
});

posix('pending then done across two waits', async () => {
  const { root, stateDir } = tmpDir();
  const s = stepScript(root, 'ok', `setTimeout(() => rr.writeResult(stateDir, key, { ok: true, n: 7 }), 700);`);
  const r = startOrAttach({ stateDir, key: 'k1', argv: [s, stateDir, 'k1'], cwd: root });
  expect(r.started).toBe(true);
  const w1 = await waitForResult({ stateDir, key: 'k1', waitMs: 150, pollMs: 50 });
  expect(w1.status).toBe('pending');
  expect(w1.pid).toBe(r.pid);
  expect(w1.elapsedMs).toBeGreaterThanOrEqual(100);
  const w2 = await waitForResult({ stateDir, key: 'k1', waitMs: 5000, pollMs: 50 });
  expect(w2).toEqual({ status: 'done', result: { ok: true, n: 7 } });
});

posix('attach with the same key starts one child', async () => {
  const { root, stateDir } = tmpDir();
  const count = path.join(root, 'count.txt');
  const s = stepScript(root, 'once', `fs.appendFileSync(mark, 'x'); setTimeout(() => rr.writeResult(stateDir, key, { ok: true }), 800);`);
  const a = startOrAttach({ stateDir, key: 'same', argv: [s, stateDir, 'same', count], cwd: root });
  const b = startOrAttach({ stateDir, key: 'same', argv: [s, stateDir, 'same', count], cwd: root });
  expect(a.started).toBe(true);
  expect(b).toEqual({ pid: a.pid, started: false });
  const w = await waitForResult({ stateDir, key: 'same', waitMs: 5000, pollMs: 50 });
  expect(w.status).toBe('done');
  expect(fs.readFileSync(count, 'utf8')).toBe('x');
});

posix('a new key kills the old step and its child', async () => {
  const { root, stateDir } = tmpDir();
  const pidFile = path.join(root, 'old.pid');
  const old = stepScript(root, 'old', `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(mark, JSON.stringify({ step: process.pid, child: g.pid }));
    setTimeout(() => {}, 60000);`);
  const a = startOrAttach({ stateDir, key: 'old', argv: [old, stateDir, 'old', pidFile], cwd: root });
  expect(await waitFile(pidFile)).toBe(true);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  extraPids.push(pids.step, pids.child);
  const fresh = stepScript(root, 'fresh', `setTimeout(() => rr.writeResult(stateDir, key, { ok: 'new' }), 300);`);
  const b = startOrAttach({ stateDir, key: 'new', argv: [fresh, stateDir, 'new'], cwd: root });
  expect(b.started).toBe(true);
  expect(b.pid).not.toBe(a.pid);
  expect(await waitDead(a.pid)).toBe(true);
  expect(await waitDead(pids.step)).toBe(true);
  expect(await waitDead(pids.child)).toBe(true);
  const w = await waitForResult({ stateDir, key: 'new', waitMs: 5000, pollMs: 50 });
  expect(w).toEqual({ status: 'done', result: { ok: 'new' } });
});

posix('a step that exits without a result is lost with its log text', async () => {
  const { root, stateDir } = tmpDir();
  const s = stepScript(root, 'crash', `console.error('voice model exploded'); setTimeout(() => process.exit(3), 300);`);
  startOrAttach({ stateDir, key: 'c', argv: [s, stateDir, 'c'], cwd: root });
  const w = await waitForResult({ stateDir, key: 'c', waitMs: 5000, pollMs: 50 });
  expect(w.status).toBe('lost');
  expect(w.error).toContain('voice model exploded');
  expect(readLogTail(stateDir)).toContain('voice model exploded');
});

posix('a result for another key is ignored, and an unparsable result is not yet written', async () => {
  const { root, stateDir } = tmpDir();
  const s = stepScript(root, 'slow', `setTimeout(() => {}, 1500);`);
  startOrAttach({ stateDir, key: 'mine', argv: [s, stateDir, 'mine'], cwd: root });
  writeResult(stateDir, 'theirs', { ok: true });
  expect((await waitForResult({ stateDir, key: 'mine', waitMs: 200, pollMs: 50 })).status).toBe('pending');
  fs.writeFileSync(path.join(stateDir, 'result.json'), '{"key":"mine","res');
  expect((await waitForResult({ stateDir, key: 'mine', waitMs: 200, pollMs: 50 })).status).toBe('pending');
  writeResult(stateDir, 'mine', { ok: 1 });
  expect(await waitForResult({ stateDir, key: 'mine', waitMs: 200, pollMs: 50 })).toEqual({ status: 'done', result: { ok: 1 } });
});

posix('lease expiry abandons the run and kills the step and its child', async () => {
  const { root, stateDir } = tmpDir();
  const pidFile = path.join(root, 'lease.pid');
  const s = stepScript(root, 'forever', `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(mark, JSON.stringify({ step: process.pid, child: g.pid }));
    setTimeout(() => {}, 60000);`);
  const r = startOrAttach({ stateDir, key: 'L', argv: [s, stateDir, 'L', pidFile], cwd: root, leaseMs: 2000 });
  expect(await waitFile(pidFile)).toBe(true);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  extraPids.push(pids.step, pids.child);
  // No caller checks in: within leaseMs + one check interval (250 ms) the supervisor gives up.
  expect(await waitDead(r.pid)).toBe(true);
  expect(await waitDead(pids.step)).toBe(true);
  expect(await waitDead(pids.child)).toBe(true);
  const res = JSON.parse(fs.readFileSync(path.join(stateDir, 'result.json'), 'utf8'));
  expect(res).toEqual({ key: 'L', result: { ok: false, error: 'abandoned: no caller for 0 min' } });
  const w = await waitForResult({ stateDir, key: 'L', waitMs: 100, pollMs: 50 });
  expect(w.status).toBe('done');
  expect(w.result.error).toMatch(/^abandoned: no caller for/);
});

posix('a supervisor delayed past the lease length still starts its step and is not reclaimed', async () => {
  const { root, stateDir } = tmpDir();
  const pidFile = path.join(root, 'late.pid');
  // Preload that stalls only the supervisor (not its step) for longer than the lease.
  const delay = path.join(root, 'delay.cjs');
  fs.writeFileSync(delay, `if (process.argv.includes('__supervise')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);`);
  const s = stepScript(root, 'late', `fs.writeFileSync(mark, String(process.pid)); setTimeout(() => {}, 60000);`);
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${delay}`;
  let r;
  try {
    r = startOrAttach({ stateDir, key: 'D', argv: [s, stateDir, 'D', pidFile], cwd: root, leaseMs: 2000 });
  } finally {
    if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
  }
  expect(await waitFile(pidFile)).toBe(true);
  extraPids.push(Number(fs.readFileSync(pidFile, 'utf8')));
  // The step started 2.5 s after startOrAttach (lease 2 s): no abandonment was recorded.
  expect(fs.existsSync(path.join(stateDir, 'result.json'))).toBe(false);
  expect(alive(r.pid)).toBe(true);
});

posix('waitForResult checks refresh the lease so a waited-on run is not abandoned', async () => {
  const { root, stateDir } = tmpDir();
  const s = stepScript(root, 'long', `setTimeout(() => rr.writeResult(stateDir, key, { ok: true }), 1500);`);
  startOrAttach({ stateDir, key: 'W', argv: [s, stateDir, 'W'], cwd: root, leaseMs: 600 });
  const w = await waitForResult({ stateDir, key: 'W', waitMs: 5000, pollMs: 50 });
  expect(w).toEqual({ status: 'done', result: { ok: true } });
});

posix('waitForResult never waits longer than waitMs + pollMs', async () => {
  const { root, stateDir } = tmpDir();
  const s = stepScript(root, 'idle', `setTimeout(() => {}, 1500);`);
  startOrAttach({ stateDir, key: 'B', argv: [s, stateDir, 'B'], cwd: root });
  const t0 = Date.now();
  const w = await waitForResult({ stateDir, key: 'B', waitMs: 300, pollMs: 200 });
  const took = Date.now() - t0;
  expect(w.status).toBe('pending');
  expect(took).toBeGreaterThanOrEqual(290);
  expect(took).toBeLessThan(300 + 200 + 100);
});

test('winTreeKillArgv ends the whole tree with taskkill /T /F', () => {
  expect(winTreeKillArgv(123)).toEqual(['taskkill', '/PID', '123', '/T', '/F']);
});

/** Live supervisor pids for stateDir. */
function supervisorPids(stateDir) {
  const out = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout || '';
  return out.split('\n')
    .filter((l) => l.includes('__supervise') && l.includes(stateDir))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && alive(pid));
}

posix('two concurrent starts for the same key leave exactly one supervisor', async () => {
  const { root, stateDir } = tmpDir();
  const s = stepScript(root, 'race', `setTimeout(() => rr.writeResult(stateDir, key, { ok: true }), 3000);`);
  const at = Date.now() + 400;
  const code = `
    const rr = require(${JSON.stringify(MOD)});
    while (Date.now() < ${at}) {}
    const r = rr.startOrAttach({ stateDir: ${JSON.stringify(stateDir)}, key: 'race', argv: [${JSON.stringify(s)}, ${JSON.stringify(stateDir)}, 'race'], cwd: ${JSON.stringify(root)} });
    process.stdout.write(JSON.stringify(r));`;
  const { spawn } = require('node:child_process');
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (status) => resolve({ status, out }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  const ra = JSON.parse(a.out);
  const rb = JSON.parse(b.out);
  expect([ra.started, rb.started].sort()).toEqual([false, true]);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  expect(ra.pid).toBe(state.pid);
  expect(rb.pid).toBe(state.pid);
  expect(alive(state.pid)).toBe(true);
  expect(supervisorPids(stateDir)).toEqual([state.pid]);
  expect(fs.existsSync(path.join(stateDir, 'start.lock'))).toBe(false);
});

posix('a stale start lock older than 30 s is removed', () => {
  const { root, stateDir } = tmpDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'start.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lock, old, old);
  const s = stepScript(root, 'stale', `setTimeout(() => rr.writeResult(stateDir, key, { ok: true }), 300);`);
  const r = startOrAttach({ stateDir, key: 'S', argv: [s, stateDir, 'S'], cwd: root });
  expect(r.started).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
});

posix('a step that leaves a grandchild behind does not outlive the run', async () => {
  const { root, stateDir } = tmpDir();
  const pidFile = path.join(root, 'gc.pid');
  const s = stepScript(root, 'leaky', `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    g.unref();
    fs.writeFileSync(mark, String(g.pid));
    rr.writeResult(stateDir, key, { ok: true });
    process.exit(0);`);
  startOrAttach({ stateDir, key: 'G', argv: [s, stateDir, 'G', pidFile], cwd: root });
  const w = await waitForResult({ stateDir, key: 'G', waitMs: 5000, pollMs: 50 });
  expect(w).toEqual({ status: 'done', result: { ok: true } });
  expect(await waitFile(pidFile)).toBe(true);
  const gc = Number(fs.readFileSync(pidFile, 'utf8'));
  extraPids.push(gc);
  expect(await waitDead(gc, 2000)).toBe(true);
});

posix('a fresh run truncates run.log; attaching leaves it untouched', async () => {
  const { root, stateDir } = tmpDir();
  const s1 = stepScript(root, 'first', `console.log('first-run-output'); rr.writeResult(stateDir, key, { ok: 1 });`);
  startOrAttach({ stateDir, key: 'R', argv: [s1, stateDir, 'R'], cwd: root });
  expect((await waitForResult({ stateDir, key: 'R', waitMs: 5000, pollMs: 50 })).status).toBe('done');
  const st1 = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  expect(await waitDead(st1.pid)).toBe(true);
  expect(readLogTail(stateDir)).toContain('first-run-output');
  // Step 2 stays alive until the test releases it (no wall-clock timer), and the test
  // waits for its first output line to reach run.log instead of sleeping.
  const release = path.join(root, 'release');
  const s2 = stepScript(root, 'second', `console.log('second-run-output'); const t = setInterval(() => { if (fs.existsSync(mark)) { clearInterval(t); rr.writeResult(stateDir, key, { ok: 2 }); } }, 20);`);
  const a = startOrAttach({ stateDir, key: 'R', argv: [s2, stateDir, 'R', release], cwd: root });
  expect(a.started).toBe(true);
  for (let i = 0; i < 500 && !readLogTail(stateDir).includes('second-run-output'); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(readLogTail(stateDir)).toContain('second-run-output');
  expect(readLogTail(stateDir)).not.toContain('first-run-output');
  const b = startOrAttach({ stateDir, key: 'R', argv: [s2, stateDir, 'R', release], cwd: root });
  expect(b).toEqual({ pid: a.pid, started: false });
  expect(readLogTail(stateDir)).toContain('second-run-output');
  fs.writeFileSync(release, '');
  expect((await waitForResult({ stateDir, key: 'R', waitMs: 5000, pollMs: 50 })).status).toBe('done');
  const log = fs.readFileSync(path.join(stateDir, 'run.log'), 'utf8');
  expect(log).toContain('second-run-output');
  expect(log).not.toContain('first-run-output');
});
