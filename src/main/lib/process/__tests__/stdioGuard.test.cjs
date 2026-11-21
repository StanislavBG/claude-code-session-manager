import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const { guardStdio, isDeadStdioWriteError, createUncaughtReportFilter } = require('../stdioGuard.cjs');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'stdioGuardChild.cjs');

function runChild(mode, target, ms = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, mode, target], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out')); }, ms);
    // Drain the stream we do NOT kill so it cannot back up.
    const keep = target === 'stderr' ? child.stdout : child.stderr;
    keep.on('data', () => {});
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('message', (msg) => {
      if (msg === 'ready') {
        (target === 'stderr' ? child.stderr : child.stdout).destroy();
        setTimeout(() => child.send('go'), 50);
        return;
      }
      clearTimeout(t);
      resolve(msg);
    });
    child.on('exit', (code) => {
      setTimeout(() => { clearTimeout(t); reject(new Error(`child exited ${code} without a report`)); }, 500);
    });
  });
}

describe('guardStdio — dead stdout in a real child', () => {
  // Control: proves the bug is real. If this goes red, Node fixed the console
  // write-error handling upstream and the guard may be revisited.
  it('UNGUARDED control child raises uncaughtException on console.log after its reader closed', async () => {
    const r = await runChild('control', 'stdout');
    expect(r.uncaught).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('guarded child raises 0 uncaughtException and logs at most once', async () => {
    const r = await runChild('guard', 'stdout');
    expect(r.uncaught).toBe(0);
    expect(r.logCalls.length).toBeLessThanOrEqual(1);
    for (const c of r.logCalls) {
      expect(c.stream).toBe('stdout');
      expect(['EIO', 'EPIPE', 'ECONNRESET', 'ENXIO', 'EBADF']).toContain(c.code);
    }
  }, 30000);

  it('guarded child survives a dead stderr (console.warn / console.error)', async () => {
    const r = await runChild('guard', 'stderr');
    expect(r.uncaught).toBe(0);
    expect(r.logCalls.length).toBeLessThanOrEqual(1);
  }, 30000);
});

describe('guardStdio — in-process behavior', () => {
  function fakeStream() {
    const s = new PassThrough();
    s.resume();
    return s;
  }

  it('is idempotent: a second call adds no second error listener', () => {
    const a = fakeStream();
    const b = fakeStream();
    const streams = [{ name: 'stdout', stream: a }, { name: 'stderr', stream: b }];
    guardStdio({ streams });
    const na = a.listenerCount('error');
    const nb = b.listenerCount('error');
    expect(na).toBe(1);
    guardStdio({ streams });
    expect(a.listenerCount('error')).toBe(na);
    expect(b.listenerCount('error')).toBe(nb);
  });

  it('idempotent on the real process.stdout / process.stderr', () => {
    guardStdio();
    const o = process.stdout.listenerCount('error');
    const e = process.stderr.listenerCount('error');
    guardStdio();
    expect(process.stdout.listenerCount('error')).toBe(o);
    expect(process.stderr.listenerCount('error')).toBe(e);
  });

  it('dead code: replaces write with a no-op, logs once, swallows a throwing log', async () => {
    const s = fakeStream();
    const calls = [];
    guardStdio({ streams: [{ name: 'stdout', stream: s }], log: (i) => { calls.push(i); throw new Error('boom'); } });
    const original = s.write;
    s.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO', syscall: 'write' }));
    s.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }));
    expect(calls).toEqual([{ stream: 'stdout', code: 'EIO' }]);
    expect(s.write).not.toBe(original);
    let cb = 0;
    expect(s.write('x', () => { cb += 1; })).toBe(true);
    expect(s.write('x', 'utf8', () => { cb += 1; })).toBe(true);
    expect(cb).toBe(0);
    await new Promise((r) => process.nextTick(r));
    expect(cb).toBe(2);
  });

  it('other code: swallowed, logged once per code, write untouched', () => {
    const s = fakeStream();
    const calls = [];
    guardStdio({ streams: [{ name: 'stderr', stream: s }], log: (i) => calls.push(i) });
    const original = s.write;
    s.emit('error', Object.assign(new Error('x'), { code: 'EWEIRD' }));
    s.emit('error', Object.assign(new Error('x'), { code: 'EWEIRD' }));
    s.emit('error', Object.assign(new Error('y'), { code: 'EOTHER' }));
    expect(calls).toEqual([{ stream: 'stderr', code: 'EWEIRD' }, { stream: 'stderr', code: 'EOTHER' }]);
    expect(s.write).toBe(original);
  });

  it('never throws on bad input', () => {
    expect(() => guardStdio({ streams: [null, {}, { name: 'x', stream: null }, 42] })).not.toThrow();
    expect(() => guardStdio(undefined)).not.toThrow();
  });
});

describe('isDeadStdioWriteError', () => {
  it('truth table', () => {
    for (const code of ['EIO', 'EPIPE', 'ECONNRESET', 'ENXIO', 'EBADF']) {
      expect(isDeadStdioWriteError({ syscall: 'write', code })).toBe(true);
      expect(isDeadStdioWriteError({ syscall: 'read', code })).toBe(false);
      expect(isDeadStdioWriteError({ code })).toBe(false);
    }
    expect(isDeadStdioWriteError({ syscall: 'write', code: 'EACCES' })).toBe(false);
    expect(isDeadStdioWriteError(Object.assign(new Error('write EIO'), { syscall: 'write', code: 'EIO' }))).toBe(true);
    expect(isDeadStdioWriteError(null)).toBe(false);
    expect(isDeadStdioWriteError(undefined)).toBe(false);
    expect(isDeadStdioWriteError('write EIO')).toBe(false);
    expect(isDeadStdioWriteError(5)).toBe(false);
  });
});

describe('createUncaughtReportFilter', () => {
  it('reports every non-dead error, only the FIRST dead-stdio write error', () => {
    const f = createUncaughtReportFilter();
    const dead = () => Object.assign(new Error('write EIO'), { syscall: 'write', code: 'EIO' });
    const other = new Error('real bug');
    expect(f(other)).toBe(true);
    expect(f(dead())).toBe(true);
    expect(f(dead())).toBe(false);
    expect(f({ syscall: 'write', code: 'EPIPE' })).toBe(false);
    expect(f(other)).toBe(true);
    expect(f(null)).toBe(true);
    expect(f('string')).toBe(true);
    // A fresh filter has its own state.
    expect(createUncaughtReportFilter()(dead())).toBe(true);
  });
});
