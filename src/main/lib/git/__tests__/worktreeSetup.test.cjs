'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runWorktreeSetup } = require('../worktreeSetup.cjs');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-setup-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
const write = (obj) => fs.writeFileSync(path.join(dir, '.session-manager.json'), JSON.stringify(obj));

describe('runWorktreeSetup', () => {
  it('returns ran:false when no config file', async () => {
    expect(await runWorktreeSetup({ worktreeCwd: dir })).toEqual({ ran: false });
  });
  it('returns ran:false when worktreeSetup is absent', async () => {
    write({ other: 1 });
    expect(await runWorktreeSetup({ worktreeCwd: dir })).toEqual({ ran: false });
  });
  it('refuses an invalid entry', async () => {
    write({ worktreeSetup: ['echo hi | cat'] });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r.ran).toBe(false);
    expect(typeof r.error).toBe('string');
  });
  it('runs a passing command in the worktree cwd', async () => {
    write({ worktreeSetup: [`timeout 30 node -e 'require("fs").writeFileSync("ran.txt","x")'`] });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r).toEqual({ ran: true, ok: true });
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(true);
  });
  it('a failing command (exit 3) does not throw', async () => {
    write({ worktreeSetup: ["timeout 30 node -e 'process.exit(3)'"] });
    const r = await runWorktreeSetup({ worktreeCwd: dir });
    expect(r).toEqual({ ran: true, ok: false });
    expect(console.warn.mock.calls.join(' ')).toContain('exit 3');
  });
});
