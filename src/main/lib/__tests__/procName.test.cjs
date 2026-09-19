// PRD pn-01: procName primitive. HOME is redirected to a temp dir for the whole file
// (procnamesRoot() resolves lazily from HOME) — never the real ~/.claude.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'procname-'));
const realHome = process.env.HOME;
process.env.HOME = tmpHome; // stays redirected: procnamesRoot() resolves lazily
const { aliasBinFor, smArgv0, procnamesRoot, pruneStaleAliases } = require('../procName.cjs');

afterAll(() => {
  process.env.HOME = realHome;
  try { fs.chmodSync(procnamesRoot(), 0o700); } catch { /* absent */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function fakeBin(name) {
  const p = path.join(tmpHome, name);
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

describe('procName', () => {
  it('procnamesRoot() lives under the temp HOME machine-state root', () => {
    expect(procnamesRoot()).toBe(path.join(tmpHome, '.claude', 'session-manager', 'procnames'));
  });

  it('creates a symlink and returns the alias path', () => {
    const bin = fakeBin('bin-a');
    const out = aliasBinFor(bin, 'sm-claude-job');
    expect(out).toBe(path.join(procnamesRoot(), 'sm-claude-job'));
    expect(fs.readlinkSync(out)).toBe(bin);
  });

  it('self-repairs a drifted link', () => {
    const a = fakeBin('bin-b1');
    const b = fakeBin('bin-b2');
    aliasBinFor(a, 'sm-claude-chat');
    const out = aliasBinFor(b, 'sm-claude-chat');
    expect(fs.readlinkSync(out)).toBe(b);
  });

  it('throws on an alias longer than 15 chars', () => {
    expect(() => aliasBinFor(fakeBin('bin-c'), 'sm-claude-toolong-x')).toThrow(/TASK_COMM_LEN/);
    expect(() => aliasBinFor(fakeBin('bin-c'), 'session-manager')).not.toThrow();
  });

  it('returns the original bin for an unresolvable bare name', () => {
    expect(aliasBinFor('definitely-not-a-real-cmd-xyz', 'sm-claude-aux')).toBe('definitely-not-a-real-cmd-xyz');
  });

  it.skipIf(process.getuid && process.getuid() === 0)('fails open when procnamesRoot() is read-only', () => {
    const bin = fakeBin('bin-d');
    fs.mkdirSync(procnamesRoot(), { recursive: true });
    fs.chmodSync(procnamesRoot(), 0o500);
    try {
      expect(aliasBinFor(bin, 'sm-shell')).toBe(bin);
    } finally {
      fs.chmodSync(procnamesRoot(), 0o700);
    }
  });

  it('smArgv0 shape, sanitisation, and length bound', () => {
    expect(smArgv0('job', 'prd 12/x!')).toBe('sm-claude-job:prd12x');
    expect(smArgv0('job', 'a'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('smArgv0 always matches the live /\\bclaude\\b/ gates for every role', () => {
    // Replicated verbatim from scheduler.cjs killOrphanClaudePid & reaperHelpers.cjs claudePidAlive.
    const gate = /\bclaude\b/;
    for (const role of ['job', 'chat', 'aux', 'helper', '', undefined, '!!!', 'x'.repeat(300)]) {
      for (const detail of ['abc', '', undefined, null, '///', 'y'.repeat(300)]) {
        const label = smArgv0(role, detail);
        expect(gate.test(label)).toBe(true);
        expect(label.length).toBeLessThanOrEqual(120);
      }
    }
  });

  it('pruneStaleAliases removes dead links and keeps live ones', () => {
    const live = fakeBin('bin-live');
    const dead = fakeBin('bin-dead');
    const liveAlias = aliasBinFor(live, 'sm-live');
    const deadAlias = aliasBinFor(dead, 'sm-dead');
    fs.rmSync(dead);
    expect(() => pruneStaleAliases()).not.toThrow();
    expect(fs.existsSync(liveAlias)).toBe(true);
    expect(fs.lstatSync(deadAlias, { throwIfNoEntry: false })).toBeUndefined();
  });
});
