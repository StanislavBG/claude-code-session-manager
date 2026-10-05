/**
 * defaultShell.test.cjs — pure platform-aware interactive-shell chooser for pty.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/defaultShell.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { defaultShell } = require('../defaultShell.cjs');

test('win32 with pwsh on PATH prefers pwsh.exe', () => {
  const pwsh = 'C:\\Tools\\pwsh\\pwsh.exe';
  const r = defaultShell({
    platform: 'win32',
    env: { PATH: 'C:\\Windows;C:\\Tools\\pwsh', SystemRoot: 'C:\\Windows' },
    exists: (p) => p === pwsh,
  });
  expect(r).toEqual({ file: pwsh, args: ['-NoLogo'] });
});

test('win32 with pwsh only under %ProgramFiles%\\PowerShell\\7', () => {
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const r = defaultShell({
    platform: 'win32',
    env: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    exists: (p) => p === pwsh,
  });
  expect(r).toEqual({ file: pwsh, args: ['-NoLogo'] });
});

test('win32 without pwsh falls back to Windows PowerShell 5.1', () => {
  const r = defaultShell({
    platform: 'win32',
    env: { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
    exists: () => false,
  });
  expect(r).toEqual({
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoLogo'],
  });
});

test('darwin uses $SHELL with -il', () => {
  const r = defaultShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, exists: () => false });
  expect(r).toEqual({ file: '/bin/zsh', args: ['-il'] });
});

test('linux without SHELL falls back to /bin/bash', () => {
  const r = defaultShell({ platform: 'linux', env: {}, exists: () => false });
  expect(r).toEqual({ file: '/bin/bash', args: ['-il'] });
});
