// PRD 1065 — post-exit process-group sweep. A detached job's descendants must
// not outlive the job (2026-08-31 starry-night-ships incident: orphaned test
// batteries reparented to init after their job exited normally).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openLog, withChildAndLog, POST_EXIT_GROUP_SWEEP_GRACE_MS } = require('../childWithLog.cjs');

let dir;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('childWithLog post-exit group sweep (PRD 1065)', () => {
  it.skipIf(process.platform !== 'linux')(
    'kills a detached child\'s backgrounded grandchild after exit + grace',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-child-sweep-'));
      const logPath = path.join(dir, 'job.log');
      const pidFile = path.join(dir, 'grandchild.pid');
      const { fd, safeLog, closeFd } = openLog(logPath);

      const exited = new Promise((resolve) => {
        withChildAndLog({
          fd,
          logPath,
          safeLog,
          closeFd,
          spawn: {
            command: 'sh',
            args: [
              '-c',
              `sleep 30 & echo $! > ${pidFile}; exec sleep 0.2`,
            ],
            options: { detached: true },
          },
          onExit: () => resolve(),
        });
      });

      await exited;

      // Grandchild pid file is written by a backgrounded subshell that may
      // race the parent's own exit; give it a moment to land.
      for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 1).toBe(true);

      // Wait past the SIGTERM->SIGKILL grace window.
      await new Promise((r) => setTimeout(r, POST_EXIT_GROUP_SWEEP_GRACE_MS + 1000));

      expect(() => process.kill(grandchildPid, 0)).toThrow();
    },
    15000,
  );
});

// PRD 1110 — the sweep above kills silently; onExit must also report what it
// swept so a project whose jobs leak repeatedly can see it instead of
// inferring it from ps.
describe('childWithLog onExit leakedDescendants reporting (PRD 1110)', () => {
  it.skipIf(process.platform !== 'linux')(
    'reports a backgrounded grandchild still alive when enumeration ran',
    // Enumeration is async and the kill never waits on it, so the grandchild
    // ignores SIGTERM to stay observable until the SIGKILL sweep.
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-child-leak-'));
      const logPath = path.join(dir, 'job.log');
      const pidFile = path.join(dir, 'grandchild.pid');
      const { fd, safeLog, closeFd } = openLog(logPath);

      const exitInfo = await new Promise((resolve) => {
        withChildAndLog({
          fd,
          logPath,
          safeLog,
          closeFd,
          spawn: {
            command: 'sh',
            args: [
              '-c',
              `(trap '' TERM; exec sleep 30) & echo $! > ${pidFile}; exec sleep 0.2`,
            ],
            options: { detached: true },
          },
          onExit: (info) => resolve(info),
        });
      });

      for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());

      expect(Array.isArray(exitInfo.leakedDescendants)).toBe(true);
      expect(exitInfo.leakedDescendants.length).toBeGreaterThan(0);
      const found = exitInfo.leakedDescendants.find((p) => p.pid === grandchildPid);
      expect(found).toBeTruthy();
      expect(found.comm).toBeTruthy();
      expect(typeof found.pcpu).toBe('number');
      expect(typeof found.etimes).toBe('number');

      // Let the sweep's SIGTERM->SIGKILL cascade finish so the grandchild
      // doesn't leak past this test.
      await new Promise((r) => setTimeout(r, POST_EXIT_GROUP_SWEEP_GRACE_MS + 1000));
    },
    15000,
  );

  it.skipIf(process.platform !== 'linux')(
    'reports [] for a clean job that leaked nothing',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-child-clean-'));
      const logPath = path.join(dir, 'job.log');
      const { fd, safeLog, closeFd } = openLog(logPath);

      const exitInfo = await new Promise((resolve) => {
        withChildAndLog({
          fd,
          logPath,
          safeLog,
          closeFd,
          spawn: {
            command: 'sh',
            args: ['-c', 'exit 0'],
            options: { detached: true },
          },
          onExit: (info) => resolve(info),
        });
      });

      expect(exitInfo.leakedDescendants).toEqual([]);
    },
    15000,
  );
});

// PRD 1353 — async enumeration must never block/alter the kill cascade, and a
// throwing watchdog must not break the wall-clock kill path.
describe('childWithLog async enumeration + guarded watchdog (PRD 1353)', () => {
  const { _deps } = require('../childWithLog.cjs');
  const realExecFile = _deps.execFile;
  afterEach(() => { _deps.execFile = realExecFile; });

  it.skipIf(process.platform !== 'linux')(
    'enumeration failure omits the report, logs, and still kills the group',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-child-enumfail-'));
      const logPath = path.join(dir, 'job.log');
      const pidFile = path.join(dir, 'grandchild.pid');
      const { fd, safeLog, closeFd } = openLog(logPath);
      _deps.execFile = (_c, _a, _o, cb) => { setImmediate(() => cb(new Error('ps boom'))); };

      const exitInfo = await new Promise((resolve) => {
        withChildAndLog({
          fd, logPath, safeLog, closeFd,
          spawn: {
            command: 'sh',
            args: ['-c', `sleep 30 & echo $! > ${pidFile}; exec sleep 0.2`],
            options: { detached: true },
          },
          onExit: (info) => { info.safeLog('onExit-ran\n'); resolve(info); },
        });
      });
      expect(exitInfo.leakedDescendants).toEqual([]);
      for (let i = 0; i < 20 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
      const gc = Number(fs.readFileSync(pidFile, 'utf8').trim());
      await new Promise((r) => setTimeout(r, 500)); // SIGTERM lands immediately, no grace wait
      expect(() => process.kill(gc, 0)).toThrow();
      expect(fs.readFileSync(logPath, 'utf8')).toContain('enumeration failed');
    },
    15000,
  );

  function runWatchdog(wd) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-child-wd-'));
    const logPath = path.join(dir, 'job.log');
    const { fd, safeLog, closeFd } = openLog(logPath);
    let handle;
    const done = new Promise((resolve) => {
      handle = withChildAndLog({
        fd, logPath, safeLog, closeFd,
        spawn: { command: 'sleep', args: ['5'], options: {} },
        watchdogs: [{ label: 'w', intervalMs: 20, ...wd }],
        onExit: resolve,
      });
    });
    return { logPath, handle, done };
  }

  it('a throwing shouldFire does not stop a later tick firing the action', async () => {
    let calls = 0;
    let fired = 0;
    const { handle, logPath, done } = runWatchdog({
      shouldFire: () => { calls++; if (calls < 3) throw new Error('sf boom'); return true; },
      action: (ctx) => { fired++; ctx.killedByWatchdog = 'w'; ctx.killTree('SIGTERM'); },
    });
    const info = await done;
    expect(fired).toBe(1);
    expect(info.killedByWatchdog).toBe('w');
    expect(fs.readFileSync(logPath, 'utf8')).toContain('watchdog "w" threw: sf boom');
    handle.cancel();
  }, 10000);

  it('a throwing action clears its interval and is logged', async () => {
    let should = 0;
    let acts = 0;
    const { handle, logPath, done } = runWatchdog({
      shouldFire: () => { should++; return true; },
      action: () => { acts++; throw new Error('act boom'); },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(acts).toBe(1);
    expect(should).toBe(1);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('watchdog "w" threw: act boom');
    handle.cancel();
    await done;
  }, 10000);
});
