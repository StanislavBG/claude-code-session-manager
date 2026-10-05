'use strict';

import { describe, it, expect, afterEach } from 'vitest';
const { claudeSpawnTarget } = require('../claudeBin.cjs');

const CMD = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd';
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe';
const win = { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, exists: () => true };
const saved = process.env.SM_CLAUDE_BIN;
afterEach(() => { if (saved === undefined) delete process.env.SM_CLAUDE_BIN; else process.env.SM_CLAUDE_BIN = saved; });

describe('claudeSpawnTarget windows wrapping', () => {
  it('wraps a win32 claude.cmd in cmd.exe /d /s /c', () => {
    delete process.env.SM_CLAUDE_BIN;
    const t = claudeSpawnTarget('job', 'x', CMD, ['-p', 'hi there'], win);
    expect(t.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(t.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(t.args[3]).toContain('claude.cmd');
    expect(t.windowsVerbatimArguments).toBe(true);
  });
  it('wraps an SM_CLAUDE_BIN that ends in .cmd', () => {
    process.env.SM_CLAUDE_BIN = CMD;
    const t = claudeSpawnTarget('chat', 'x', CMD, ['-p'], win);
    expect(t.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(t.windowsVerbatimArguments).toBe(true);
  });
  it('passes a win32 claude.exe through untouched', () => {
    delete process.env.SM_CLAUDE_BIN;
    const t = claudeSpawnTarget('job', 'x', EXE, ['-p'], win);
    expect(t.command).toBe(EXE);
    expect(t.args).toBeUndefined();
    expect(t.windowsVerbatimArguments).toBeUndefined();
  });
  it('passes POSIX through untouched, even for a .cmd name', () => {
    process.env.SM_CLAUDE_BIN = '/usr/bin/claude.cmd';
    const t = claudeSpawnTarget('job', 'x', '/usr/bin/claude.cmd', ['-p'], { platform: 'linux' });
    expect(t).toEqual({ command: '/usr/bin/claude.cmd' });
  });
});
