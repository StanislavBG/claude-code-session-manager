'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runWorktreeSetup } = require('../worktreeSetup.cjs');
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
