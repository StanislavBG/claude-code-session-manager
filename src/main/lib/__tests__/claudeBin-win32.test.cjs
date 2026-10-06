/**
 * claudeBin-win32.test.cjs — resolveClaudeBin / userBinDirs / pathWithUserBins
 * are platform-aware via injected { platform, env, homedir }. POSIX output
 * must stay byte-identical to the pre-Windows-port behaviour.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/claudeBin-win32.test.cjs
 */

'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const path = require('node:path');
const fs = require('node:fs');
const { resolveClaudeBin, __resetForTests } = require('../claudeBin.cjs');
const { userBinDirs, pathWithUserBins } = require('../cleanEnv.cjs');

const W = path.win32;
const winEnv = {
  USERPROFILE: 'C:\\Users\\bob',
  APPDATA: 'C:\\Users\\bob\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\bob\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
};

describe('resolveClaudeBin win32', () => {
  let savedBin;
  beforeEach(() => { savedBin = process.env.SM_CLAUDE_BIN; delete process.env.SM_CLAUDE_BIN; __resetForTests(); });
  afterEach(() => { if (savedBin !== undefined) process.env.SM_CLAUDE_BIN = savedBin; __resetForTests(); });

  it('probes native, npm, then LOCALAPPDATA with F_OK, and falls back to claude', () => {
    const probed = [];
    const accessSync = (p, mode) => { probed.push([p, mode]); throw new Error('ENOENT'); };
    const out = resolveClaudeBin({ platform: 'win32', env: winEnv, homedir: 'C:\\Users\\bob', accessSync });
    expect(out).toBe('claude');
    expect(probed.map((x) => x[0])).toEqual([
      'C:\\Users\\bob\\.local\\bin\\claude.exe',
      'C:\\Users\\bob\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Users\\bob\\AppData\\Local\\Programs\\claude\\claude.exe',
    ]);
    expect(probed.every((x) => x[1] === fs.constants.F_OK)).toBe(true);
  });

  it('returns the first existing candidate', () => {
    const hit = 'C:\\Users\\bob\\AppData\\Roaming\\npm\\claude.cmd';
    const accessSync = (p) => { if (p !== hit) throw new Error('ENOENT'); };
    expect(resolveClaudeBin({ platform: 'win32', env: winEnv, homedir: 'C:\\Users\\bob', accessSync })).toBe(hit);
  });
});

describe('resolveClaudeBin posix', () => {
  beforeEach(() => { delete process.env.SM_CLAUDE_BIN; __resetForTests(); });
  it('keeps POSIX candidate order and X_OK', () => {
    const probed = [];
    const accessSync = (p, mode) => { probed.push([p, mode]); throw new Error('ENOENT'); };
    for (const platform of ['linux', 'darwin']) {
      probed.length = 0;
      expect(resolveClaudeBin({ platform, homedir: '/h', accessSync })).toBe('claude');
      expect(probed).toEqual([
        ['/h/.claude/local/claude', fs.constants.X_OK],
        ['/h/.local/bin/claude', fs.constants.X_OK],
        ['/h/.npm-global/bin/claude', fs.constants.X_OK],
        ['/usr/local/bin/claude', fs.constants.X_OK],
        ['/opt/homebrew/bin/claude', fs.constants.X_OK],
        ['/usr/bin/claude', fs.constants.X_OK],
      ]);
    }
  });
});

describe('userBinDirs / pathWithUserBins', () => {
  it('win32 dirs in order, skipping unset env vars', () => {
    expect(userBinDirs({ platform: 'win32', env: winEnv })).toEqual([
      W.join(winEnv.USERPROFILE, '.local', 'bin'),
      W.join(winEnv.APPDATA, 'npm'),
      W.join(winEnv.ProgramFiles, 'Git', 'cmd'),
      W.join(winEnv.ProgramFiles, 'nodejs'),
    ]);
    expect(userBinDirs({ platform: 'win32', env: { APPDATA: winEnv.APPDATA } })).toEqual([
      W.join(winEnv.APPDATA, 'npm'),
    ]);
  });

  it('win32 joins with ; and reads Path case-insensitively', () => {
    const env = { ...winEnv, Path: 'C:\\Windows' };
    const out = pathWithUserBins({ platform: 'win32', env });
    expect(out.startsWith('C:\\Windows;')).toBe(true);
    expect(out).toContain(';C:\\Program Files\\nodejs');
    expect(out).not.toContain(':C:');
  });

  it('win32 with no PATH returns just the dirs', () => {
    expect(pathWithUserBins({ platform: 'win32', env: { APPDATA: 'C:\\A' } })).toBe('C:\\A\\npm');
  });

  it('posix output is byte-identical to the legacy list and join', () => {
    const homedir = '/h';
    const legacy = [
      path.posix.join(homedir, '.claude', 'local'),
      path.posix.join(homedir, '.local', 'bin'),
      path.posix.join(homedir, '.npm-global', 'bin'),
      '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin',
    ];
    for (const platform of ['linux', 'darwin']) {
      expect(userBinDirs({ platform, homedir })).toEqual(legacy);
      expect(pathWithUserBins({ platform, homedir, env: { PATH: '/x:/y' } })).toBe(`/x:/y:${legacy.join(':')}`);
      expect(pathWithUserBins({ platform, homedir, env: {} })).toBe(legacy.join(':'));
    }
  });
});
