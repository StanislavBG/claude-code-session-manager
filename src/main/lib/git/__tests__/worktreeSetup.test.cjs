'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runWorktreeSetup, formatSetupOutcome, isSetupSettled } = require('../worktreeSetup.cjs');
const { parseChain, runGateSequence } = require('../../scheduler/definitionOfDone.cjs');

let dir;
let dirs;
beforeEach(() => {
  dirs = [];
  dir = mk();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function mk() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-setup-'));
  dirs.push(d);
  return d;
}
const writeIn = (d, obj) => fs.writeFileSync(path.join(d, '.session-manager.json'), JSON.stringify(obj));
const write = (obj) => writeIn(dir, obj);
// Gate-syntax command that records its own start/end ms in cwd, busy ~300 ms.
const MARK = `timeout 30 node -e 'const fs=require("fs");const s=Date.now();while(Date.now()-s<300);fs.writeFileSync("mark.json",JSON.stringify({s,e:Date.now()}))'`;
const mark = (d) => JSON.parse(fs.readFileSync(path.join(d, 'mark.json'), 'utf8'));

describe('runWorktreeSetup skip reasons', () => {
  it('no-config when no config file anywhere', async () => {
    expect(await runWorktreeSetup({ worktreeCwd: dir })).toMatchObject({ ran: false, ok: false, reason: 'no-config', commands: [], waitedMs: 0, ms: 0 });
  });
  it('not-in-worktree when only mainCwd declares a setup', async () => {
    const main = mk();
    writeIn(main, { worktreeSetup: ['timeout 30 true'] });
    const r = await runWorktreeSetup({ worktreeCwd: dir, mainCwd: main });
    expect(r).toMatchObject({ ran: false, reason: 'not-in-worktree' });
    expect(console.warn.mock.calls.join(' ')).toContain('commit');
  });
  it('no-config when mainCwd only declares ["none"]', async () => {
    const main = mk();
    writeIn(main, { worktreeSetup: ['None'] });
    expect((await runWorktreeSetup({ worktreeCwd: dir, mainCwd: main })).reason).toBe('no-config');
  });
  it('unreadable on bad JSON', async () => {
    fs.writeFileSync(path.join(dir, '.session-manager.json'), '{nope');
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r.reason).toBe('unreadable');
    expect(typeof r.error).toBe('string');
  });
  it('not-declared when worktreeSetup is absent', async () => {
    write({ other: 1 });
    expect((await runWorktreeSetup({ worktreeCwd: dir })).reason).toBe('not-declared');
  });
  it('invalid when worktreeSetup is not an array', async () => {
    write({ worktreeSetup: 'echo hi' });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r).toMatchObject({ ran: false, reason: 'invalid', error: 'worktreeSetup must be an array of gate-syntax strings' });
  });
  it('invalid when validateGate refuses an entry', async () => {
    write({ worktreeSetup: ['echo hi | cat'] });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r.reason).toBe('invalid');
    expect(typeof r.error).toBe('string');
  });
  it('opt-out on ["none"]', async () => {
    write({ worktreeSetup: ['none'] });
    expect((await runWorktreeSetup({ worktreeCwd: dir })).reason).toBe('opt-out');
  });
  it('error (never throws) on a bad argument shape', async () => {
    const r = await runWorktreeSetup(null);
    expect(r.ran).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});

describe('runWorktreeSetup runs', () => {
  it('passed: runs in the worktree cwd and reports per-command data', async () => {
    write({ worktreeSetup: [`timeout 30 node -e 'require("fs").writeFileSync("ran.txt","x")'`] });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r).toMatchObject({ ran: true, ok: true, reason: 'passed' });
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toMatchObject({ status: 'pass', code: 0, timedOut: false });
    expect(r.commands[0].tail.length).toBeLessThanOrEqual(1000);
    expect(r.commands[0]).not.toHaveProperty('outputTail');
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(true);
  });
  it('failed: exit 3 does not throw and stops the sequence', async () => {
    write({ worktreeSetup: ["timeout 30 node -e 'process.exit(3)'", "timeout 30 node -e 'process.exit(0)'"] });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r).toMatchObject({ ran: true, ok: false, reason: 'failed' });
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].code).toBe(3);
    expect(console.warn.mock.calls.join(' ')).toContain('exit 3');
  });
  it('same mainCwd in two dirs: second waits and starts after the first ends', async () => {
    const main = mk();
    const d2 = mk();
    write({ worktreeSetup: [MARK] });
    writeIn(d2, { worktreeSetup: [MARK] });
    const [a, b] = await Promise.all([
      runWorktreeSetup({ worktreeCwd: dir, mainCwd: main }),
      runWorktreeSetup({ worktreeCwd: d2, mainCwd: main }),
    ]);
    expect(a.reason).toBe('passed');
    expect(b.reason).toBe('passed');
    expect(mark(d2).s).toBeGreaterThanOrEqual(mark(dir).e);
    expect(b.waitedMs).toBeGreaterThan(0);
  });
  it('different mainCwd keys overlap', async () => {
    const d2 = mk();
    write({ worktreeSetup: [MARK] });
    writeIn(d2, { worktreeSetup: [MARK] });
    await Promise.all([
      runWorktreeSetup({ worktreeCwd: dir, mainCwd: mk() }),
      runWorktreeSetup({ worktreeCwd: d2, mainCwd: mk() }),
    ]);
    expect(mark(d2).s).toBeLessThan(mark(dir).e);
    expect(mark(dir).s).toBeLessThan(mark(d2).e);
  });
  it('runs while runGateSequence is in flight, and a gate during a setup is not busy', async () => {
    write({ worktreeSetup: [MARK] });
    const slow = parseChain(`timeout 30 node -e 'setTimeout(()=>{},500)'`);
    const gate = runGateSequence(slow, { cwd: dir });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r).toMatchObject({ ran: true, ok: true, reason: 'passed' });
    expect((await gate).status).toBe('green');

    const setup = runWorktreeSetup({ worktreeCwd: dir });
    const g2 = await runGateSequence(parseChain(`timeout 30 node -e '0'`), { cwd: dir });
    expect(g2.status).toBe('green');
    expect((await setup).reason).toBe('passed');
  });
});

describe('formatSetupOutcome', () => {
  const P = '[scheduler] worktree setup:';
  const ran = (o) => ({ ran: true, ok: true, reason: 'passed', waitedMs: 0, ms: 2400, commands: [{ cmd: 'a', code: 0, ms: 1200, timedOut: false, tail: 'SECRET' }], ...o });
  it('is empty for null/undefined/no-config/in-place/garbage', () => {
    for (const o of [null, undefined, { reason: 'no-config' }, { reason: 'in-place' }, 5, 'x']) expect(formatSetupOutcome(o)).toEqual([]);
  });
  it('passed: summary + per-command line, no output text', () => {
    expect(formatSetupOutcome(ran())).toEqual([`${P} passed — 1 command(s) in 2.4s`, `${P}   exit 0 in 1200ms: a`]);
  });
  it('waited >= 1000ms is reported, less is not', () => {
    expect(formatSetupOutcome(ran({ waitedMs: 3000 }))[0]).toBe(`${P} passed — 1 command(s) in 2.4s, waited 3s`);
    expect(formatSetupOutcome(ran({ waitedMs: 999 }))[0]).not.toContain('waited');
  });
  it('failed with a timed-out command points at meta.json', () => {
    const lines = formatSetupOutcome(ran({ ok: false, reason: 'failed', commands: [{ cmd: 'b', code: null, ms: 5, timedOut: true, tail: 'rate limit' }] }));
    expect(lines[1]).toBe(`${P}   exit n/a in 5ms, timed out: b`);
    expect(lines[2]).toContain('worktreeSetup.commands[].tail');
    expect(lines.join('\n')).not.toContain('rate limit');
  });
  it('skip reasons', () => {
    for (const reason of ['unreadable', 'not-declared', 'invalid', 'opt-out', 'no-commands', 'dep-link-disabled', 'error']) {
      expect(formatSetupOutcome({ ran: false, ok: false, reason, commands: [] })).toEqual([`${P} skipped — ${reason}`]);
    }
    expect(formatSetupOutcome({ ran: false, reason: 'invalid', error: 'bad' })).toEqual([`${P} skipped — invalid: bad`]);
    const nw = formatSetupOutcome({ ran: false, reason: 'not-in-worktree' });
    expect(nw[0]).toBe(`${P} skipped — not-in-worktree`);
    expect(nw[1]).toContain('main checkout');
  });
  it('truncates every line to 500 chars with an ellipsis', () => {
    const long = 'x'.repeat(2000);
    const lines = [...formatSetupOutcome(ran({ commands: [{ cmd: long, code: 0, ms: 1 }] })), ...formatSetupOutcome({ ran: false, reason: 'error', error: long })];
    for (const l of lines) { expect(l.length).toBeLessThanOrEqual(500); expect(l.startsWith(P)).toBe(true); }
    expect(lines[1].endsWith('…')).toBe(true);
  });
  it('never throws on malformed input', () => {
    expect(() => formatSetupOutcome({ ran: true, commands: [null, 3] })).not.toThrow();
    expect(() => formatSetupOutcome({ ran: true, commands: 'x', reason: {} })).not.toThrow();
  });
});

describe('isSetupSettled', () => {
  it('truth table', () => {
    for (const r of ['no-config', 'not-declared', 'opt-out']) expect(isSetupSettled({ ok: false, reason: r })).toBe(true);
    expect(isSetupSettled({ ok: true, reason: 'passed' })).toBe(true);
    for (const r of ['failed', 'unavailable', 'not-in-worktree', 'unreadable', 'invalid', 'no-commands', 'error', 'in-place', 'dep-link-disabled']) {
      expect(isSetupSettled({ ok: false, reason: r })).toBe(false);
    }
    for (const o of [null, undefined, {}, 'x', 1]) expect(isSetupSettled(o)).toBe(false);
  });
});
