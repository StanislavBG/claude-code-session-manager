/**
 * runInTerminal.test.cjs — argv construction per platform with injected spawn.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/runInTerminal.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const { EventEmitter } = require('node:events');
const { runInTerminal } = require('../openExternalApp.cjs');

function fakeSpawn() {
  const calls = [];
  const fn = vi.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  });
  return { fn, calls };
}

test('darwin: osascript with escaped quotes and pipes', async () => {
  const { fn, calls } = fakeSpawn();
  const command = 'curl -fsSL "https://x.sh" | bash';
  const r = await runInTerminal({ command, shell: 'sh' }, { platform: 'darwin', spawn: fn });
  expect(r.ok).toBe(true);
  expect(calls[0].cmd).toBe('osascript');
  expect(calls[0].args[0]).toBe('-e');
  expect(calls[0].args[1]).toContain('tell application "Terminal"');
  expect(calls[0].args[1]).toContain('do script "curl -fsSL \\"https://x.sh\\" | bash"');
  expect(calls[0].opts.shell).toBeUndefined();
});

test('darwin: backslashes are escaped before quotes', async () => {
  const { fn, calls } = fakeSpawn();
  await runInTerminal({ command: 'echo \\"hi\\"', shell: 'sh' }, { platform: 'darwin', spawn: fn });
  expect(calls[0].args[1]).toContain('do script "echo \\\\\\"hi\\\\\\""');
});

test('linux: gnome-terminal runs bash -lc with exec bash', async () => {
  const { fn, calls } = fakeSpawn();
  const r = await runInTerminal({ command: 'sudo apt install git', shell: 'sh' },
    { platform: 'linux', spawn: fn, find: (n) => (n === 'gnome-terminal' ? '/usr/bin/gnome-terminal' : null) });
  expect(r.ok).toBe(true);
  expect(calls[0].cmd).toBe('gnome-terminal');
  expect(calls[0].args).toEqual(['--', 'bash', '-lc', 'sudo apt install git; exec bash']);
});

test('linux: xterm fallback uses -e argv', async () => {
  const { fn, calls } = fakeSpawn();
  await runInTerminal({ command: 'x', shell: 'sh' },
    { platform: 'linux', spawn: fn, find: (n) => (n === 'xterm' ? '/usr/bin/xterm' : null) });
  expect(calls[0].cmd).toBe('xterm');
  expect(calls[0].args).toEqual(['-e', 'bash', '-lc', 'x; exec bash']);
});

test('linux: no terminal found', async () => {
  const { fn } = fakeSpawn();
  const r = await runInTerminal({ command: 'x', shell: 'sh' }, { platform: 'linux', spawn: fn, find: () => null });
  expect(r).toEqual({ ok: false, error: 'no terminal found' });
  expect(fn).not.toHaveBeenCalled();
});

test('win32: cmd /d /c start powershell -NoExit -Command', async () => {
  const { fn, calls } = fakeSpawn();
  const r = await runInTerminal({ command: 'winget install Git.Git', shell: 'powershell' }, { platform: 'win32', spawn: fn });
  expect(r.ok).toBe(true);
  expect(calls[0].cmd).toBe('cmd.exe');
  expect(calls[0].args).toEqual(['/d', '/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', 'winget install Git.Git']);
});

test('empty command rejected', async () => {
  const { fn } = fakeSpawn();
  const r = await runInTerminal({ command: ' ', shell: 'sh' }, { platform: 'darwin', spawn: fn });
  expect(r.ok).toBe(false);
});
