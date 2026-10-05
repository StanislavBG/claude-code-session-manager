/**
 * openExternalApp-win32.test.cjs — win32 argv for openInTerminal / openInFinder
 * with injected platform/spawn/findCommand.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/openExternalApp-win32.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { shell: { openPath: async () => '' } };
  return origLoad.call(this, req, ...rest);
};
const { EventEmitter } = require('node:events');
const { openInTerminal, openInFinder } = require('../openExternalApp.cjs');
Module._load = origLoad;

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

test('wt.exe present: launches wt.exe -d <cwd>', async () => {
  const { fn, calls } = fakeSpawn();
  const r = await openInTerminal({ cwd: 'C:\\proj' }, {
    platform: 'win32', spawn: fn, findCommand: (n) => (n === 'wt.exe' ? 'C:\\wt.exe' : null),
  });
  expect(r).toEqual({ ok: true, opener: 'wt' });
  expect(calls[0].cmd).toBe('wt.exe');
  expect(calls[0].args).toEqual(['-d', 'C:\\proj']);
  expect(calls[0].opts.shell).toBeUndefined();
});

test('wt.exe absent: cmd.exe start powershell -NoExit Set-Location', async () => {
  const { fn, calls } = fakeSpawn();
  const r = await openInTerminal({ cwd: 'C:\\proj' }, { platform: 'win32', spawn: fn, findCommand: () => null });
  expect(r).toEqual({ ok: true, opener: 'powershell' });
  expect(calls[0].cmd).toBe('cmd.exe');
  expect(calls[0].args).toEqual([
    '/d', '/c', 'start', '', 'powershell.exe', '-NoExit', '-Command',
    "Set-Location -LiteralPath 'C:\\proj'",
  ]);
  expect(calls[0].opts.windowsHide).toBe(true);
  expect(calls[0].opts.shell).toBeUndefined();
});

test('powershell fallback doubles single quotes and keeps spaces', async () => {
  const { fn, calls } = fakeSpawn();
  await openInTerminal({ cwd: "C:\\Users\\O'Brien\\my proj" }, { platform: 'win32', spawn: fn, findCommand: () => null });
  expect(calls[0].args[calls[0].args.length - 1])
    .toBe("Set-Location -LiteralPath 'C:\\Users\\O''Brien\\my proj'");
});

test('wt.exe path passes cwd with spaces/quote as a single argv element', async () => {
  const { fn, calls } = fakeSpawn();
  const cwd = "C:\\a b\\it's";
  await openInTerminal({ cwd }, { platform: 'win32', spawn: fn, findCommand: () => 'wt.exe' });
  expect(calls[0].args).toEqual(['-d', cwd]);
});

test('openInFinder on win32 spawns explorer.exe <cwd>', async () => {
  const { fn, calls } = fakeSpawn();
  const r = await openInFinder({ cwd: 'C:\\my proj' }, { platform: 'win32', spawn: fn });
  expect(r).toEqual({ ok: true, opener: 'explorer' });
  expect(calls[0].cmd).toBe('explorer.exe');
  expect(calls[0].args).toEqual(['C:\\my proj']);
  expect(calls[0].opts.shell).toBeUndefined();
});
