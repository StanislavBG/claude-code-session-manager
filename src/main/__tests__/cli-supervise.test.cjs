import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sup = require('../../../bin/supervise.cjs');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sup-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('logsDir', () => {
  it('SM_LOGS_DIR wins; platform defaults otherwise', () => {
    expect(sup.logsDir({ SM_LOGS_DIR: dir }, 'linux', '/h')).toBe(dir);
    expect(sup.logsDir({}, 'linux', '/h')).toBe('/h/.config/claude-code-session-manager/logs');
    expect(sup.logsDir({}, 'darwin', '/h')).toBe('/h/Library/Application Support/claude-code-session-manager/logs');
    expect(sup.logsDir({ APPDATA: '/a' }, 'win32', '/h')).toBe(path.join('/a', 'claude-code-session-manager', 'logs'));
  });
});

describe('shouldRespawn', () => {
  const open = { open: true, pid: 42 };
  it('respawns on unclean exit with open sentinel for the pid', () => {
    expect(sup.shouldRespawn({ code: null, signal: 'SIGKILL', sentinel: open, childPid: 42 })).toBe(true);
    expect(sup.shouldRespawn({ code: 1, signal: null, sentinel: open, childPid: 42 })).toBe(true);
    expect(sup.shouldRespawn({ code: 0, signal: null, sentinel: open, childPid: 42 })).toBe(true);
  });
  it('never respawns on closed sentinel, forwarded signal, closed/foreign sentinel', () => {
    expect(sup.shouldRespawn({ code: 0, signal: null, sentinel: { open: false, pid: 42 }, childPid: 42 })).toBe(false);
    expect(sup.shouldRespawn({ code: 0, signal: null, sentinel: open, childPid: 7 })).toBe(false);
    expect(sup.shouldRespawn({ code: null, signal: 'SIGTERM', forwardedSignal: 'SIGTERM', sentinel: open, childPid: 42 })).toBe(false);
    expect(sup.shouldRespawn({ code: 1, signal: null, sentinel: { open: false, pid: 42 }, childPid: 42 })).toBe(false);
    expect(sup.shouldRespawn({ code: 1, signal: null, sentinel: open, childPid: 7 })).toBe(false);
    expect(sup.shouldRespawn({ code: 1, signal: null, sentinel: null, childPid: 42 })).toBe(false);
  });
});

describe('checkCrashLoop', () => {
  it('allows 5 respawns in 10 minutes, refuses the 6th, forgets old ones', () => {
    let ts = [];
    for (let i = 0; i < 5; i++) {
      const r = sup.checkCrashLoop(ts, 1000 + i);
      expect(r.allow).toBe(true);
      ts = r.timestamps;
    }
    expect(sup.checkCrashLoop(ts, 2000).allow).toBe(false);
    expect(sup.checkCrashLoop(ts, 1000 + sup.RESPAWN_WINDOW_MS + 10).allow).toBe(true);
  });
});

describe('disk helpers', () => {
  it('recordExit caps at 200 lines keeping the newest', () => {
    for (let i = 0; i < 205; i++) sup.recordExit(dir, { ts: 't', pid: i, code: 1, signal: null, uptimeMs: 1 });
    const lines = fs.readFileSync(path.join(dir, sup.EXIT_LOG), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(200);
    expect(JSON.parse(lines[0]).pid).toBe(5);
    expect(JSON.parse(lines[199]).pid).toBe(204);
  });

  it('appendStderr rotates to .1 at the byte limit', () => {
    sup.appendStderr(dir, 'aaaa', 10);
    sup.appendStderr(dir, 'bbbbbbbb', 10);
    sup.appendStderr(dir, 'cc', 10);
    const f = path.join(dir, sup.STDERR_LOG);
    expect(fs.readFileSync(f, 'utf8')).toBe('cc');
    expect(fs.readFileSync(f + '.1', 'utf8')).toBe('aaaabbbbbbbb');
  });

  it('readSentinel parses last-run.json and tolerates absence', () => {
    expect(sup.readSentinel(dir)).toBe(null);
    fs.writeFileSync(path.join(dir, sup.SENTINEL), JSON.stringify({ open: true, pid: 3 }));
    expect(sup.readSentinel(dir)).toEqual({ open: true, pid: 3 });
  });

  it('helpers never throw on an unwritable dir', () => {
    const bad = path.join(dir, 'file');
    fs.writeFileSync(bad, 'x');
    expect(() => sup.recordExit(path.join(bad, 'sub'), { a: 1 })).not.toThrow();
    expect(() => sup.appendStderr(path.join(bad, 'sub'), 'x')).not.toThrow();
  });
});
