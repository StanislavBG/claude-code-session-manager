/**
 * appPreviewScripts.test.cjs — package.json script listing, loopback URL
 * detection (ANSI-tolerant), free-port allocation and script-name validation.
 *
 * Run: timeout 120 npx vitest run src/main/lib/app-preview/__tests__/appPreviewScripts.test.cjs
 */

'use strict';

import { test, expect, afterEach, describe } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {
  listPreviewScripts, detectLocalUrl, stripAnsi, findFreePort, isValidScriptName, SCRIPT_NAME_RE,
} = require('../appPreviewScripts.cjs');

const ESC = '\u001b';
const dirs = [];
function tmp(pkg) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'app-preview-'));
  dirs.push(d);
  if (pkg !== undefined) {
    fs.writeFileSync(path.join(d, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  }
  return d;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('listPreviewScripts', () => {
  test('lists string scripts in package.json order with suggested dev', () => {
    const d = tmp({ scripts: { build: 'vite build', start: 'node s.js', dev: 'vite' } });
    expect(listPreviewScripts(d)).toEqual({
      ok: true,
      scripts: [
        { name: 'build', command: 'vite build' },
        { name: 'start', command: 'node s.js' },
        { name: 'dev', command: 'vite' },
      ],
      suggested: 'dev',
    });
  });

  test('suggested falls through start, serve, preview, develop, then null', () => {
    expect(listPreviewScripts(tmp({ scripts: { serve: 'x', start: 'y' } })).suggested).toBe('start');
    expect(listPreviewScripts(tmp({ scripts: { preview: 'x', serve: 'y' } })).suggested).toBe('serve');
    expect(listPreviewScripts(tmp({ scripts: { develop: 'x', preview: 'y' } })).suggested).toBe('preview');
    expect(listPreviewScripts(tmp({ scripts: { develop: 'x' } })).suggested).toBe('develop');
    expect(listPreviewScripts(tmp({ scripts: { build: 'x' } })).suggested).toBeNull();
  });

  test('skips invalid names and non-string or empty values', () => {
    const d = tmp({ scripts: { '--inspect': 'a', 'bad name': 'b', 'x;y': 'c', num: 5, empty: '', obj: {}, ok: 'run' } });
    expect(listPreviewScripts(d)).toEqual({ ok: true, scripts: [{ name: 'ok', command: 'run' }], suggested: null });
  });

  test('caps at 200 entries and truncates commands to 500 chars', () => {
    const scripts = {};
    for (let i = 0; i < 250; i++) scripts[`s${i}`] = 'x'.repeat(600);
    const r = listPreviewScripts(tmp({ scripts }));
    expect(r.ok).toBe(true);
    expect(r.scripts).toHaveLength(200);
    expect(r.scripts[0].name).toBe('s0');
    expect(r.scripts[199].name).toBe('s199');
    expect(r.scripts[0].command).toHaveLength(500);
  });

  test('missing package.json names the folder', () => {
    const d = tmp();
    expect(listPreviewScripts(d)).toEqual({ ok: false, error: `No package.json in ${d}` });
  });

  test('invalid JSON names the folder', () => {
    const d = tmp('{ not json');
    expect(listPreviewScripts(d)).toEqual({ ok: false, error: `package.json in ${d} is not valid JSON` });
  });

  test('no usable scripts names the folder', () => {
    for (const pkg of [{}, { scripts: {} }, { scripts: 'x' }, { scripts: { '-x': 'a', y: '' } }, null, []]) {
      const d = tmp(pkg);
      expect(listPreviewScripts(d)).toEqual({ ok: false, error: `package.json in ${d} has no runnable scripts` });
    }
  });

  test('never throws on a bad dir argument', () => {
    expect(listPreviewScripts(undefined).ok).toBe(false);
    expect(listPreviewScripts(42).ok).toBe(false);
  });
});

describe('stripAnsi', () => {
  test('removes CSI and OSC sequences', () => {
    expect(stripAnsi(`${ESC}[1m${ESC}[32mok${ESC}[0m`)).toBe('ok');
    expect(stripAnsi(`${ESC}]8;;http://x\u0007link${ESC}]8;;\u0007`)).toBe('link');
    expect(stripAnsi(`${ESC}]0;title${ESC}\\rest`)).toBe('rest');
    expect(stripAnsi('')).toBe('');
  });
});

describe('detectLocalUrl', () => {
  test('Vite line with ANSI codes inside the URL', () => {
    const line = `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`;
    expect(detectLocalUrl(line)).toBe('http://localhost:5173/');
  });

  test('Next.js line', () => {
    expect(detectLocalUrl('   - Local:        http://localhost:3000\n   - Network: http://192.168.1.5:3000'))
      .toBe('http://localhost:3000');
  });

  test('CRA-style 0.0.0.0 rewritten to localhost', () => {
    expect(detectLocalUrl('  On Your Network:  http://0.0.0.0:3000')).toBe('http://localhost:3000');
  });

  test('[::] rewritten, [::1] and 127.0.0.1 kept, https supported', () => {
    expect(detectLocalUrl('listening on http://[::]:8080/')).toBe('http://localhost:8080/');
    expect(detectLocalUrl('at http://[::1]:4000')).toBe('http://[::1]:4000');
    expect(detectLocalUrl('at https://127.0.0.1:8443/app')).toBe('https://127.0.0.1:8443/app');
    expect(detectLocalUrl('see http://localhost/')).toBe('http://localhost/');
  });

  test('trims trailing . , ; )', () => {
    expect(detectLocalUrl('Server at http://localhost:3000.')).toBe('http://localhost:3000');
    expect(detectLocalUrl('(http://localhost:3000/),')).toBe('http://localhost:3000/');
    expect(detectLocalUrl('url http://localhost:3000;')).toBe('http://localhost:3000');
  });

  test('first match in text order', () => {
    expect(detectLocalUrl('http://127.0.0.1:1111 then http://localhost:2222')).toBe('http://127.0.0.1:1111');
  });

  test('null for non-loopback, ws://, bad ports and empty input', () => {
    expect(detectLocalUrl('docs at https://example.com/x')).toBeNull();
    expect(detectLocalUrl('hmr ws://localhost:24678')).toBeNull();
    expect(detectLocalUrl('http://localhost.evil.com:3000')).toBeNull();
    expect(detectLocalUrl('http://localhost:0')).toBeNull();
    expect(detectLocalUrl('http://localhost:70000')).toBeNull();
    expect(detectLocalUrl('')).toBeNull();
    expect(detectLocalUrl(undefined)).toBeNull();
  });
});

describe('findFreePort', () => {
  test('resolves a port in 1024-65535 that can then be bound', async () => {
    const port = await findFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
    await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => s.close(resolve));
    });
  });

  test('rejects when listening fails', async () => {
    const orig = net.createServer;
    net.createServer = () => {
      const s = orig();
      s.listen = () => { process.nextTick(() => s.emit('error', new Error('EACCES'))); return s; };
      return s;
    };
    try {
      await expect(findFreePort()).rejects.toThrow('EACCES');
    } finally {
      net.createServer = orig;
    }
  });
});

describe('SCRIPT_NAME_RE / isValidScriptName', () => {
  test('regex source is exact', () => {
    expect(SCRIPT_NAME_RE.source).toBe('^[A-Za-z0-9@_][A-Za-z0-9:_.@/-]{0,99}$');
  });
  test('accepts dev, build:watch, @scope/dev', () => {
    for (const n of ['dev', 'build:watch', '@scope/dev']) expect(isValidScriptName(n)).toBe(true);
  });
  test('rejects flags, spaces, shell metacharacters, non-strings, too long', () => {
    for (const n of ['--inspect', '-x', 'a b', 'a;b', 'a|b', 'a&b', 'a$b', 'a`b', '', 'a'.repeat(101), 5, null]) {
      expect(isValidScriptName(n)).toBe(false);
    }
  });
});
