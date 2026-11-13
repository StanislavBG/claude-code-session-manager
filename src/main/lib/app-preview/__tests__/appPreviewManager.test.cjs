/**
 * appPreviewManager.test.cjs — one dev server per Epic: refused starts, spawn
 * contract, URL detection across chunks, failure/exit/timeout transitions,
 * SIGTERM→SIGKILL stop, synchronous stopAll, plus one real npm-run process.
 *
 * Run: timeout 120 npx vitest run src/main/lib/app-preview/__tests__/appPreviewManager.test.cjs
 */

'use strict';

import { test, expect, afterEach, describe } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAppPreviewManager } = require('../appPreviewManager.cjs');

const ESC = '\u001b';
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function harness(over = {}) {
  const spawned = [];
  const kills = [];
  const broadcasts = [];
  const opened = [];
  const sweeps = [];
  let nextChild = null;
  const deps = {
    spawn: (cmd, args, opts) => {
      const child = nextChild || fakeChild();
      nextChild = null;
      spawned.push({ cmd, args, opts, child });
      return child;
    },
    killTree: (pid, sig) => { kills.push({ pid, sig }); return true; },
    openExternal: (url) => { opened.push(url); return Promise.resolve(); },
    broadcast: (s) => broadcasts.push(s),
    sweep: (epicId) => { sweeps.push(epicId); return 0; },
    findFreePort: async () => 51234,
    listScripts: () => ({ ok: true, scripts: [{ name: 'dev', command: 'vite' }], suggested: 'dev' }),
    platform: 'linux',
    now: () => Date.parse('2026-11-12T10:00:00.000Z'),
    ...over,
  };
  const mgr = createAppPreviewManager(deps);
  return { mgr, spawned, kills, broadcasts, opened, sweeps, setNextChild: (c) => { nextChild = c; } };
}

const START = { cwd: '/proj', epicId: 'e1', dir: '/proj/wt', script: 'dev' };

describe('exports', () => {
  test('returns the five methods and works with no deps', () => {
    const mgr = createAppPreviewManager();
    for (const k of ['start', 'stop', 'stopAll', 'list', 'get']) expect(typeof mgr[k]).toBe('function');
    expect(mgr.list()).toEqual([]);
    expect(mgr.get('nope')).toBeNull();
  });
});

describe('refused starts', () => {
  test('invalid script name: error, no broadcast, no spawn', async () => {
    const h = harness();
    const r = await h.mgr.start({ ...START, script: '--inspect' });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(h.broadcasts).toEqual([]);
    expect(h.spawned).toEqual([]);
  });
  test('listScripts not ok: error, no broadcast', async () => {
    const h = harness({ listScripts: () => ({ ok: false, error: 'No package.json in /proj/wt' }) });
    const r = await h.mgr.start(START);
    expect(r).toEqual({ ok: false, error: 'No package.json in /proj/wt' });
    expect(h.broadcasts).toEqual([]);
    expect(h.spawned).toEqual([]);
  });
  test('missing script: error, no broadcast', async () => {
    const h = harness();
    const r = await h.mgr.start({ ...START, script: 'start' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/start/);
    expect(h.broadcasts).toEqual([]);
    expect(h.spawned).toEqual([]);
  });
  test('second start while starting or running returns existing state, no respawn', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.mgr.start(START), h.mgr.start(START)]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.spawned).toHaveLength(1);
    expect(b.state.status).toBe('starting');
    h.spawned[0].child.stdout.emit('data', Buffer.from('Local: http://localhost:51234/\n'));
    const c = await h.mgr.start(START);
    expect(c).toEqual({ ok: true, state: expect.objectContaining({ status: 'running' }) });
    expect(h.spawned).toHaveLength(1);
  });
});

describe('spawn contract', () => {
  test('spawns npm run <script> detached with the preview env and broadcasts starting', async () => {
    const h = harness();
    const r = await h.mgr.start(START);
    expect(r.ok).toBe(true);
    const { cmd, args, opts } = h.spawned[0];
    expect(cmd).toBe('npm');
    expect(args).toEqual(['run', 'dev']);
    expect(opts.cwd).toBe('/proj/wt');
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.detached).toBe(true);
    expect(opts.shell).toBeUndefined();
    expect(opts.env.PORT).toBe('51234');
    expect(opts.env.BROWSER).toBe('none');
    expect(opts.env.SM_PROC_ROLE).toBe('preview');
    expect(opts.env.SM_PREVIEW_EPIC_ID).toBe('e1');
    expect(opts.env.SM_PREVIEW_OWNER_PID).toBe(String(process.pid));
    expect(opts.env.NODE_OPTIONS).toBeUndefined();
    expect(typeof opts.env.PATH).toBe('string');
    expect(r.state).toEqual({
      epicId: 'e1', cwd: '/proj', dir: '/proj/wt', script: 'dev', command: 'vite', port: 51234,
      url: null, status: 'starting', error: null, pid: 4242, startedAt: '2026-11-12T10:00:00.000Z',
    });
    expect(h.broadcasts).toEqual([r.state]);
  });
  test('passes windowsVerbatimArguments through on win32 .cmd resolution', async () => {
    const calls = [];
    const h = harness({
      platform: 'win32',
      resolveSpawn: (cmd, args, o) => {
        calls.push({ cmd, args, o });
        return { command: 'cmd.exe', args: ['/d', '/s', '/c', '"npm.cmd run dev"'], windowsVerbatimArguments: true };
      },
    });
    await h.mgr.start(START);
    expect(calls[0].cmd).toBe('npm');
    expect(calls[0].args).toEqual(['run', 'dev']);
    expect(calls[0].o.platform).toBe('win32');
    const { cmd, opts } = h.spawned[0];
    expect(cmd).toBe('cmd.exe');
    expect(opts.windowsVerbatimArguments).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.shell).toBeUndefined();
  });
});

describe('URL detection', () => {
  test('URL split across stdout chunks → running, broadcast, openExternal once', async () => {
    const h = harness();
    await h.mgr.start(START);
    const { child } = h.spawned[0];
    child.stdout.emit('data', Buffer.from(`${ESC}[32m  ➜  Local:   http://local`));
    expect(h.mgr.get('e1').status).toBe('starting');
    child.stdout.emit('data', Buffer.from(`host:51234/${ESC}[0m\n`));
    child.stdout.emit('data', Buffer.from('again http://localhost:51234/\n'));
    child.stderr.emit('data', Buffer.from('and http://127.0.0.1:9/\n'));
    await tick();
    const s = h.mgr.get('e1');
    expect(s.status).toBe('running');
    expect(s.url).toBe('http://localhost:51234/');
    expect(h.opened).toEqual(['http://localhost:51234/']);
    expect(h.broadcasts.map((b) => b.status)).toEqual(['starting', 'running']);
    expect(h.broadcasts[1]).toEqual(s);
  });
  test('URL on stderr counts', async () => {
    const h = harness();
    await h.mgr.start(START);
    h.spawned[0].child.stderr.emit('data', 'ready on http://127.0.0.1:51234\n');
    expect(h.mgr.get('e1').url).toBe('http://127.0.0.1:51234');
  });
  test('openExternal rejection (or throw) is logged, never thrown', async () => {
    const h = harness({ openExternal: () => Promise.reject(new Error('no browser')) });
    await h.mgr.start(START);
    expect(() => h.spawned[0].child.stdout.emit('data', 'http://localhost:1/\n')).not.toThrow();
    await tick();
    expect(h.mgr.get('e1').status).toBe('running');
    const h2 = harness({ openExternal: () => { throw new Error('sync boom'); } });
    await h2.mgr.start(START);
    expect(() => h2.spawned[0].child.stdout.emit('data', 'http://localhost:1/\n')).not.toThrow();
    expect(h2.mgr.get('e1').status).toBe('running');
  });
});

describe('failures', () => {
  test('spawn error with pid undefined → failed naming npm run + cause', async () => {
    const h = harness();
    h.setNextChild(Object.assign(fakeChild(), { pid: undefined }));
    const r = await h.mgr.start(START);
    expect(r.state.pid).toBeNull();
    const err = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
    h.spawned[0].child.emit('error', err);
    const s = h.mgr.get('e1');
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/npm run dev/);
    expect(s.error).toMatch(/ENOENT/);
    expect(h.broadcasts.at(-1)).toEqual(s);
    // nothing live: stop resolves immediately
    await expect(h.mgr.stop('e1')).resolves.toEqual({ ok: true });
  });
  test('exit before URL → failed with the last 8 non-empty ANSI-stripped lines', async () => {
    const h = harness();
    await h.mgr.start(START);
    const { child } = h.spawned[0];
    const lines = Array.from({ length: 12 }, (_, i) => `${ESC}[31mline ${i}${ESC}[0m`);
    child.stdout.emit('data', lines.slice(0, 6).join('\n') + '\n\n\n');
    child.stderr.emit('data', lines.slice(6).join('\r\n') + '\n');
    child.emit('exit', 1, null);
    const s = h.mgr.get('e1');
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/npm run dev/);
    expect(s.error).toMatch(/code 1/);
    expect(s.error).not.toContain(ESC);
    for (let i = 4; i < 12; i += 1) expect(s.error).toContain(`line ${i}`);
    expect(s.error).not.toContain('line 3');
    expect(h.broadcasts.map((b) => b.status)).toEqual(['starting', 'failed']);
  });
  test('no URL within urlTimeoutMs → process killed, failed', async () => {
    const h = harness({ urlTimeoutMs: 30 });
    await h.mgr.start(START);
    h.spawned[0].child.stdout.emit('data', 'compiling...\n');
    await sleep(80);
    const s = h.mgr.get('e1');
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/npm run dev/);
    expect(s.error).toMatch(/no local URL/i);
    expect(s.error).toContain('compiling...');
    expect(h.kills.some((k) => k.pid === 4242)).toBe(true);
    expect(h.sweeps).toEqual(['e1']);
    h.spawned[0].child.emit('exit', null, 'SIGKILL');
    expect(h.mgr.get('e1').status).toBe('failed');
  });
  test('URL timer is cleared once running', async () => {
    const h = harness({ urlTimeoutMs: 30 });
    await h.mgr.start(START);
    h.spawned[0].child.stdout.emit('data', 'http://localhost:3000\n');
    await sleep(80);
    expect(h.mgr.get('e1').status).toBe('running');
    expect(h.kills).toEqual([]);
  });
  test('unrequested exit after running → stopped, "Preview stopped unexpectedly"', async () => {
    const h = harness();
    await h.mgr.start(START);
    const { child } = h.spawned[0];
    child.stdout.emit('data', 'http://localhost:3000\n');
    child.emit('exit', 0, null);
    const s = h.mgr.get('e1');
    expect(s.status).toBe('stopped');
    expect(s.error.startsWith('Preview stopped unexpectedly')).toBe(true);
    expect(h.broadcasts.map((b) => b.status)).toEqual(['starting', 'running', 'stopped']);
  });
  test('a failed Epic can be started again', async () => {
    const h = harness();
    await h.mgr.start(START);
    h.spawned[0].child.emit('exit', 1, null);
    expect(h.sweeps).toEqual(['e1']);
    const r = await h.mgr.start(START);
    expect(r.state.status).toBe('starting');
    expect(h.spawned).toHaveLength(2);
  });
});

describe('stop / stopAll / list', () => {
  test('stop: SIGTERM, resolves only after exit, stopped + error null', async () => {
    const h = harness({ killGraceMs: 1000 });
    await h.mgr.start(START);
    const { child } = h.spawned[0];
    child.stdout.emit('data', 'http://localhost:3000\n');
    let done = false;
    const p = h.mgr.stop('e1').then((r) => { done = true; return r; });
    await sleep(20);
    expect(h.kills).toEqual([{ pid: 4242, sig: 'SIGTERM' }]);
    expect(done).toBe(false);
    expect(h.sweeps).toEqual([]);
    child.emit('exit', null, 'SIGTERM');
    await expect(p).resolves.toEqual({ ok: true });
    expect(h.sweeps).toEqual(['e1']);
    const s = h.mgr.get('e1');
    expect(s.status).toBe('stopped');
    expect(s.error).toBeNull();
    expect(h.broadcasts.at(-1)).toEqual(s);
  });
  test('stop: SIGKILL after killGraceMs when SIGTERM is ignored', async () => {
    const h = harness({ killGraceMs: 30 });
    await h.mgr.start(START);
    const { child } = h.spawned[0];
    const p = h.mgr.stop('e1');
    await sleep(80);
    expect(h.kills).toEqual([{ pid: 4242, sig: 'SIGTERM' }, { pid: 4242, sig: 'SIGKILL' }]);
    child.emit('exit', null, 'SIGKILL');
    await expect(p).resolves.toEqual({ ok: true });
    expect(h.mgr.get('e1')).toMatchObject({ status: 'stopped', error: null });
  });
  test('stop with nothing live resolves immediately', async () => {
    const h = harness();
    await expect(h.mgr.stop('unknown')).resolves.toEqual({ ok: true });
    expect(h.kills).toEqual([]);
  });
  test('stopAll synchronously SIGKILLs every live preview', async () => {
    const h = harness();
    h.setNextChild(fakeChild(11));
    await h.mgr.start({ ...START, epicId: 'a' });
    h.setNextChild(fakeChild(22));
    await h.mgr.start({ ...START, epicId: 'b' });
    h.spawned[1].child.emit('exit', 1, null); // b is dead already
    h.setNextChild(fakeChild(33));
    await h.mgr.start({ ...START, epicId: 'c' });
    h.mgr.stopAll();
    expect(h.kills).toEqual([{ pid: 11, sig: 'SIGKILL' }, { pid: 33, sig: 'SIGKILL' }]);
    expect(h.sweeps).toEqual(['b', 'a', 'c']); // b on its own exit, then each live epic
  });
  test('get/list return copies, one latest state per Epic', async () => {
    const h = harness();
    await h.mgr.start({ ...START, epicId: 'a' });
    await h.mgr.start({ ...START, epicId: 'b' });
    h.spawned[1].child.emit('exit', 1, null);
    const l = h.mgr.list();
    expect(l.map((s) => [s.epicId, s.status])).toEqual([['a', 'starting'], ['b', 'failed']]);
    l[0].status = 'hacked';
    h.mgr.get('a').status = 'hacked';
    expect(h.mgr.get('a').status).toBe('starting');
  });
});

describe('real process', () => {
  let mgr = null;
  const dirs = [];
  afterEach(() => {
    if (mgr) mgr.stopAll();
    mgr = null;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  test('npm run dev reaches running with the printed URL, stop kills the server', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prev-real-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { dev: 'node server.js' } }));
    fs.writeFileSync(path.join(dir, 'server.js'), [
      "const http = require('node:http');",
      "const fs = require('node:fs');",
      "fs.writeFileSync(__dirname + '/server.pid', String(process.pid));",
      'const port = Number(process.env.PORT);',
      "http.createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1', () => {",
      '  console.log(`Local: http://localhost:${port}/`);',
      '});',
    ].join('\n'));
    const opened = [];
    mgr = createAppPreviewManager({ openExternal: async (u) => { opened.push(u); } });
    const r = await mgr.start({ cwd: dir, epicId: 'real', dir, script: 'dev' });
    expect(r.ok).toBe(true);
    let s = mgr.get('real');
    for (let i = 0; i < 150 && s.status === 'starting'; i += 1) { await sleep(100); s = mgr.get('real'); }
    expect(s.status).toBe('running');
    expect(s.url).toBe(`http://localhost:${s.port}/`);
    expect(opened).toEqual([s.url]);
    const serverPid = Number(fs.readFileSync(path.join(dir, 'server.pid'), 'utf8'));
    const npmPid = s.pid;
    await expect(mgr.stop('real')).resolves.toEqual({ ok: true });
    expect(mgr.get('real')).toMatchObject({ status: 'stopped', error: null });
    const isDead = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    let dead = false;
    for (let i = 0; i < 30 && !dead; i += 1) {
      dead = isDead(serverPid) && isDead(npmPid);
      if (!dead) await sleep(100);
    }
    expect(dead).toBe(true);
  }, 20000);
});
