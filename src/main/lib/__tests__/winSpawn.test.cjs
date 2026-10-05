/**
 * winSpawn.test.cjs — resolveSpawn wraps Windows .cmd/.bat shims in an explicit
 * cmd.exe argv (no shell:true) and leaves every other platform untouched.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/winSpawn.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { resolveSpawn } = require('../winSpawn.cjs');

const mkExists = (...files) => (p) => files.includes(p);
const ENV = { PATH: 'C:\\bin;C:\\node', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };

test('non-win32 returns input unchanged', () => {
  const r = resolveSpawn('npx', ['vitest', 'run'], { platform: 'linux', env: ENV, exists: () => true });
  expect(r).toEqual({ command: 'npx', args: ['vitest', 'run'] });
});

test('win32 .cmd is wrapped in cmd.exe /d /s /c with verbatim arguments', () => {
  const r = resolveSpawn('npx', ['vitest', 'run'], {
    platform: 'win32', env: ENV, exists: mkExists('C:\\node\\npx.CMD'),
  });
  expect(r.command).toBe('C:\\Windows\\System32\\cmd.exe');
  expect(r.windowsVerbatimArguments).toBe(true);
  expect(r.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  expect(r.args).toHaveLength(4);
  expect(r.args[3]).toMatch(/^".*npx\.CMD.*vitest.*run.*"$/);
});

test('win32 defaults ComSpec to cmd.exe', () => {
  const r = resolveSpawn('npm', [], {
    platform: 'win32', env: { PATH: 'C:\\n', PATHEXT: '.CMD' }, exists: mkExists('C:\\n\\npm.CMD'),
  });
  expect(r.command).toBe('cmd.exe');
});

test('win32 .exe resolves to the full path with no wrapping', () => {
  const r = resolveSpawn('git', ['status'], {
    platform: 'win32', env: ENV, exists: mkExists('C:\\bin\\git.EXE'),
  });
  expect(r.command).toBe('C:\\bin\\git.EXE');
  expect(r.args).toEqual(['status']);
  expect(r.windowsVerbatimArguments).toBeUndefined();
});

test('PATHEXT order decides between .exe and .cmd in the same dir', () => {
  const exists = mkExists('C:\\bin\\tool.CMD', 'C:\\bin\\tool.EXE');
  const a = resolveSpawn('tool', [], { platform: 'win32', env: ENV, exists });
  expect(a.command).toBe('C:\\bin\\tool.EXE');
  const b = resolveSpawn('tool', [], {
    platform: 'win32', env: { ...ENV, PATHEXT: '.CMD;.EXE' }, exists,
  });
  expect(b.args[0]).toBe('/d');
});

test('earlier PATH dir wins over PATHEXT order', () => {
  const r = resolveSpawn('tool', [], {
    platform: 'win32', env: ENV, exists: mkExists('C:\\bin\\tool.CMD', 'C:\\node\\tool.EXE'),
  });
  expect(r.args[0]).toBe('/d');
});

test('unresolvable command is returned unchanged', () => {
  const r = resolveSpawn('nope', ['x'], { platform: 'win32', env: ENV, exists: () => false });
  expect(r).toEqual({ command: 'nope', args: ['x'] });
});

// Every cmd metacharacter outside our own ^ escaping must be preceded by ^.
function unescapedMeta(line) {
  const stripped = line.replace(/\^./g, '');
  return /[&|<>%^]/.test(stripped);
}

test('a&calc stays one literal argument', () => {
  const r = resolveSpawn('npx', ['a&calc'], { platform: 'win32', env: ENV, exists: mkExists('C:\\node\\npx.CMD') });
  const line = r.args[3].slice(1, -1);
  expect(line).toContain('a^&calc');
  expect(unescapedMeta(line)).toBe(false);
});

test('"x" | y stays one literal argument', () => {
  const r = resolveSpawn('npx', ['"x" | y'], { platform: 'win32', env: ENV, exists: mkExists('C:\\node\\npx.CMD') });
  const line = r.args[3].slice(1, -1);
  expect(line).toContain('^|');
  expect(unescapedMeta(line)).toBe(false);
  // no raw (unescaped) double quote remains after the command's own quoting
  expect(line.replace(/\^./g, '')).not.toContain('"x"');
});

test('% < > ^ are escaped', () => {
  const r = resolveSpawn('npx', ['%PATH%', 'a<b>c', 'x^y'], { platform: 'win32', env: ENV, exists: mkExists('C:\\node\\npx.CMD') });
  const line = r.args[3].slice(1, -1);
  expect(line).toContain('^%PATH^%');
  expect(line).toContain('a^<b^>c');
  expect(line).toContain('x^^y');
  expect(unescapedMeta(line)).toBe(false);
});
