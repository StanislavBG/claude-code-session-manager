// PRD: fail-closed process identity so a recycled pid can never pin
// instanceLock ownership or dodge killOrphanClaudePid's veto. Stat parsing is
// exercised against fixture files under SM_PROC_ROOT (never real /proc) so a
// synthetic `comm` containing parens/spaces can be asserted precisely.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { identity, isDifferentProcess } = require('../procIdentity.cjs');

let dir;

function writeProcEntry(root, pid, { stat, cmdline }) {
  const entryDir = path.join(root, String(pid));
  fs.mkdirSync(entryDir, { recursive: true });
  if (stat !== undefined) fs.writeFileSync(path.join(entryDir, 'stat'), stat);
  if (cmdline !== undefined) fs.writeFileSync(path.join(entryDir, 'cmdline'), cmdline);
}

// Real /proc/<pid>/stat line, comm replaced with one containing a space and
// an embedded ')' — field 22 (starttime) is `124686`, at the position AFTER
// the LAST ')', not the first.
function statLine(comm, startTicks) {
  return `12345 (${comm}) R 1 12345 12345 0 -1 4194304 118 0 0 0 0 0 0 0 32 12 1 0 ${startTicks} 18698240 440 0 0 0 0 0 0 0 0 0 0 0 17 7 0 0 0 0 0 0 0 0 0 0 0 0\n`;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-proc-identity-'));
  process.env.SM_PROC_ROOT = dir;
});

afterEach(() => {
  delete process.env.SM_PROC_ROOT;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('procIdentity.identity — /proc parsing', () => {
  it('parses field 22 located after the LAST ")" when comm contains a paren and a space', () => {
    writeProcEntry(dir, 4242, {
      stat: statLine('claude (worker)', 999888),
      cmdline: 'node\0claude\0--session-id\0abc\0',
    });
    const id = identity(4242);
    expect(id.pid).toBe(4242);
    expect(id.startTicks).toBe(999888);
    expect(id.cmdline).toBe('node claude --session-id abc');
    expect(id.complete).toBe(true);
  });

  it('reads the live node process itself from real /proc (sanity check against production code path)', () => {
    delete process.env.SM_PROC_ROOT;
    const id = identity(process.pid);
    expect(id.pid).toBe(process.pid);
    expect(typeof id.startTicks).toBe('number');
    expect(id.startTicks).toBeGreaterThan(0);
    expect(typeof id.cmdline).toBe('string');
    expect(id.cmdline.length).toBeGreaterThan(0);
    expect(id.complete).toBe(true);
    process.env.SM_PROC_ROOT = dir; // restore for afterEach
  });

  it('tri-state: missing stat file → incomplete (startTicks null) even though cmdline is readable', () => {
    writeProcEntry(dir, 5001, { cmdline: 'node\0claude\0' });
    const id = identity(5001);
    expect(id.startTicks).toBeNull();
    expect(id.cmdline).toBe('node claude');
    expect(id.complete).toBe(false);
  });

  it('tri-state: missing cmdline file → incomplete (cmdline null) even though stat is readable', () => {
    writeProcEntry(dir, 5002, { stat: statLine('claude', 111) });
    const id = identity(5002);
    expect(id.startTicks).toBe(111);
    expect(id.cmdline).toBeNull();
    expect(id.complete).toBe(false);
  });

  it('tri-state: neither file exists (pid never existed / already reaped) → incomplete, never throws', () => {
    const id = identity(999999);
    expect(id.startTicks).toBeNull();
    expect(id.cmdline).toBeNull();
    expect(id.complete).toBe(false);
  });

  it('rejects a non-positive-integer pid without touching the filesystem', () => {
    expect(identity(-1).complete).toBe(false);
    expect(identity(0).complete).toBe(false);
    expect(identity(NaN).complete).toBe(false);
  });
});

describe('procIdentity.isDifferentProcess — fail-closed decision', () => {
  const complete = (over = {}) => ({ pid: 100, startTicks: 555, cmdline: 'node claude', complete: true, ...over });

  it('true only when both sides are complete AND a field differs', () => {
    expect(isDifferentProcess(complete(), complete({ startTicks: 999 }))).toBe(true);
    expect(isDifferentProcess(complete(), complete({ cmdline: 'node other' }))).toBe(true);
    expect(isDifferentProcess(complete(), complete())).toBe(false);
  });

  it('an incomplete recorded or live side never reads as different (fail closed)', () => {
    const incomplete = { pid: 100, startTicks: null, cmdline: null, complete: false };
    expect(isDifferentProcess(incomplete, complete())).toBe(false);
    expect(isDifferentProcess(complete(), incomplete)).toBe(false);
    expect(isDifferentProcess(incomplete, incomplete)).toBe(false);
  });

  it('a null/undefined probe (unreadable /proc, process gone) never reads as different', () => {
    expect(isDifferentProcess(complete(), null)).toBe(false);
    expect(isDifferentProcess(null, complete())).toBe(false);
    expect(isDifferentProcess(undefined, undefined)).toBe(false);
  });

  it('a legacy record with no identity fields at all never reads as different', () => {
    const legacy = { pid: 100 }; // e.g. an old {pid, startedAt}-only lock body
    expect(isDifferentProcess(legacy, complete())).toBe(false);
  });
});
