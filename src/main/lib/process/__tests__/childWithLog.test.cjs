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

// A throwing watchdog must not break the wall-clock kill path.
describe('childWithLog guarded watchdog (PRD 1353)', () => {
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

// onExit runs synchronously after the group SIGTERM; no enumeration, no deferral.
describe('childWithLog sweep + sync onExit', () => {
  const realKill = process.kill;
  afterEach(() => { process.kill = realKill; });

  function setup(name) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
    const logPath = path.join(dir, 'job.log');
    return { logPath, ...openLog(logPath) };
  }

  it.skipIf(process.platform !== 'linux')('group SIGTERM is issued before onExit, which runs synchronously with the child pid', async () => {
    const { logPath, fd, safeLog, closeFd } = setup('sm-child-order-');
    const groupKills = [];
    process.kill = (pid, sig) => {
      if (pid < -1 && sig === 'SIGTERM') { groupKills.push(pid); return true; }
      return realKill.call(process, pid, sig);
    };
    let info;
    let killsAtExit = -1;
    let childRef;
    await new Promise((resolve) => {
      const r = withChildAndLog({
        fd, logPath, safeLog, closeFd,
        spawn: { command: 'sh', args: ['-c', 'exit 0'], options: { detached: true } },
        onExit: (i) => { info = i; killsAtExit = groupKills.length; resolve(); },
      });
      childRef = r.child;
    });
    expect(killsAtExit).toBe(1);
    expect(info.pid).toBe(childRef.pid);
    expect('leakedDescendants' in info).toBe(false);
  }, 15000);

  it('runs onExit synchronously when the spawn throws', () => {
    const { logPath, fd, safeLog, closeFd } = setup('sm-child-spawnfail-');
    let ran = false;
    const r = withChildAndLog({
      fd, logPath, safeLog, closeFd,
      spawn: { command: 'sh', args: [], options: { cwd: '/nonexistent\0bad', detached: true } },
      onExit: (i) => { ran = i.spawnFailed === true && i.pid === null; },
    });
    expect(r.child).toBeNull();
    expect(ran).toBe(true);
  });

  it('a throwing synchronous onExit is logged, closes the fd, and is re-thrown', async () => {
    const { logPath, fd, safeLog, closeFd } = setup('sm-child-throw-sync-');
    let closed = false;
    const wrapClose = () => { closed = true; closeFd(); };
    const thrown = await new Promise((resolve) => {
      const onUncaught = (e) => { process.off('uncaughtException', onUncaught); resolve(e); };
      process.on('uncaughtException', onUncaught);
      withChildAndLog({
        fd, logPath, safeLog, closeFd: wrapClose,
        spawn: { command: 'sh', args: ['-c', 'exit 0'] },
        onExit: () => { throw new Error('exit boom'); },
      });
    });
    expect(thrown.message).toBe('exit boom');
    expect(closed).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('onExit threw: exit boom');
  }, 15000);
});

// stdinText — hand a child its input over a stdin pipe instead of argv
// (Linux MAX_ARG_STRLEN 128 KB per argument; Windows cmd.exe 8191 chars).
describe('childWithLog stdinText', () => {
  function runStdin(script, stdinText) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-child-stdin-'));
    const logPath = path.join(dir, 'job.log');
    const outFile = path.join(dir, 'out.txt');
    const { fd, safeLog, closeFd } = openLog(logPath);
    const spec = { command: process.execPath, args: ['-e', script, outFile], options: {} };
    if (stdinText !== undefined) spec.stdinText = stdinText;
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const done = new Promise((resolve) => {
      withChildAndLog({ fd, logPath, safeLog, closeFd, spawn: spec, onExit: resolve });
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 20000));
    return Promise.race([done, timeout]).then(async (info) => {
      await new Promise((r) => setTimeout(r, 100));
      process.off('uncaughtException', onUncaught);
      return { info, uncaught, outFile, logPath };
    }, (e) => { process.off('uncaughtException', onUncaught); throw e; });
  }

  const COUNT = `
    const fs = require('node:fs'); let n = 0;
    process.stdin.on('data', (b) => { n += b.length; });
    process.stdin.on('end', () => { fs.writeFileSync(process.argv[1], String(n)); process.exit(0); });
  `;

  it('delivers a 300 KB stdinText to the child intact', async () => {
    const text = 'é'.repeat(150 * 1024); // 300 KB UTF-8
    const r = await runStdin(COUNT, text);
    expect(r.info.exitCode).toBe(0);
    expect(fs.readFileSync(r.outFile, 'utf8')).toBe(String(Buffer.byteLength(text, 'utf8')));
  }, 30000);

  it('survives a child that exits without reading a 2 MB stdinText', async () => {
    const r = await runStdin('process.exit(0)', 'x'.repeat(2 * 1024 * 1024));
    expect(r.info.exitCode).toBe(0);
    expect(r.uncaught).toEqual([]);
  }, 30000);

  it('gives EOF at once when stdinText is absent', async () => {
    const r = await runStdin(COUNT, undefined);
    expect(r.info.exitCode).toBe(0);
    expect(fs.readFileSync(r.outFile, 'utf8')).toBe('0');
  }, 30000);
});
