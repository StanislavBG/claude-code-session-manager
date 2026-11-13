/**
 * appPreviewSweep.test.cjs — /proc environ scan for preview markers, per-Epic
 * kill and orphan sweep selection, plus one real setsid grandchild that
 * escapes a group kill yet dies on manager.stop() (Linux only).
 *
 * Run: timeout 120 npx vitest run src/main/lib/app-preview/__tests__/appPreviewSweep.test.cjs
 */

'use strict';

import { test, expect, afterEach, describe } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanPreviewProcesses, killPreviewProcesses, sweepOrphanedPreviews } = require('../appPreviewSweep.cjs');
const { createAppPreviewManager } = require('../appPreviewManager.cjs');
const { pidAlive } = require('../../process/pidAlive.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (pairs) => pairs.join('\0') + '\0';

const tmpDirs = [];
function fakeProc(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prev-proc-'));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, 'uptime'), '100.0 50.0\n');
  fs.mkdirSync(path.join(root, 'self'));
  for (const [pid, environ] of Object.entries(entries)) {
    const dir = path.join(root, pid);
    fs.mkdirSync(dir);
    if (environ === null) fs.mkdirSync(path.join(dir, 'environ')); // read → EISDIR
    else fs.writeFileSync(path.join(dir, 'environ'), environ);
  }
  return root;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const PREVIEW = (epic, owner) => env(['PATH=/usr/bin', 'SM_PROC_ROLE=preview', `SM_PREVIEW_EPIC_ID=${epic}`, `SM_PREVIEW_OWNER_PID=${owner}`]);

describe('scanPreviewProcesses', () => {
  test('parses marker present, skips marker absent and unreadable environ', () => {
    const procRoot = fakeProc({
      101: PREVIEW('e1', 500),
      102: env(['PATH=/usr/bin', 'HOME=/h']),
      103: null,
      104: env(['SM_PREVIEW_EPIC_ID=e9', 'SM_PREVIEW_OWNER_PID=500']), // no role marker
      105: env(['SM_PROC_ROLE=preview', 'SM_PREVIEW_EPIC_ID=']), // empty epic id
      106: env(['SM_PROC_ROLE=preview', 'SM_PREVIEW_EPIC_ID=e2']), // no owner
    });
    const got = scanPreviewProcesses({ procRoot, platform: 'linux' }).sort((a, b) => a.pid - b.pid);
    expect(got).toEqual([
      { pid: 101, epicId: 'e1', ownerPid: 500 },
      { pid: 106, epicId: 'e2', ownerPid: null },
    ]);
  });
  test('[] off Linux and when procRoot is unreadable', () => {
    const procRoot = fakeProc({ 101: PREVIEW('e1', 500) });
    expect(scanPreviewProcesses({ procRoot, platform: 'darwin' })).toEqual([]);
    expect(scanPreviewProcesses({ procRoot: path.join(procRoot, 'missing'), platform: 'linux' })).toEqual([]);
  });
});

describe('killPreviewProcesses / sweepOrphanedPreviews', () => {
  test('kill: SIGKILLs every process of that epic except self, counts signalled', () => {
    const procRoot = fakeProc({
      201: PREVIEW('e1', 500),
      202: PREVIEW('e1', 500),
      203: PREVIEW('e2', 500),
      [process.pid]: PREVIEW('e1', 500),
    });
    const kills = [];
    const kill = (pid, sig) => { kills.push([pid, sig]); if (pid === 202) throw new Error('ESRCH'); };
    const n = killPreviewProcesses('e1', { procRoot, platform: 'linux', kill });
    expect(kills.sort((a, b) => a[0] - b[0])).toEqual([[201, 'SIGKILL'], [202, 'SIGKILL']]);
    expect(n).toBe(1);
    expect(killPreviewProcesses('', { procRoot, platform: 'linux', kill })).toBe(0);
  });
  test('sweep: kills only previews whose owner is neither us nor alive', () => {
    const procRoot = fakeProc({
      301: PREVIEW('a', process.pid), // ours
      302: PREVIEW('b', 7777), // owner alive
      303: PREVIEW('c', 8888), // owner dead
      304: env(['SM_PROC_ROLE=preview', 'SM_PREVIEW_EPIC_ID=d']), // no owner → orphan
    });
    const kills = [];
    const n = sweepOrphanedPreviews({
      procRoot,
      platform: 'linux',
      kill: (pid, sig) => { kills.push([pid, sig]); },
      pidAlive: (pid) => pid === 7777,
    });
    expect(kills.sort((a, b) => a[0] - b[0])).toEqual([[303, 'SIGKILL'], [304, 'SIGKILL']]);
    expect(n).toBe(2);
  });
  test('never throw', () => {
    const fsImpl = { readdirSync: () => { throw new Error('boom'); } };
    expect(killPreviewProcesses('e1', { fsImpl, platform: 'linux' })).toBe(0);
    expect(sweepOrphanedPreviews({ fsImpl, platform: 'linux' })).toBe(0);
    expect(sweepOrphanedPreviews({ platform: 'linux', procRoot: fakeProc({ 1: PREVIEW('x', 9) }), pidAlive: () => { throw new Error('x'); } })).toBe(0);
  });
});

describe('real setsid grandchild', () => {
  let mgr = null;
  let grandPid = null;
  const dirs = [];
  afterEach(() => {
    if (mgr) mgr.stopAll();
    mgr = null;
    if (grandPid && pidAlive(grandPid)) { try { process.kill(grandPid, 'SIGKILL'); } catch { /* gone */ } }
    grandPid = null;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  test.skipIf(process.platform !== 'linux')('a detached grandchild escapes the group kill but dies on stop()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prev-setsid-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { dev: 'node parent.js' } }));
    fs.writeFileSync(path.join(dir, 'parent.js'), [
      "const { spawn } = require('node:child_process');",
      "const http = require('node:http');",
      "const fs = require('node:fs');",
      "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'g.unref();',
      "fs.writeFileSync(__dirname + '/grand.pid', String(g.pid));",
      'const port = Number(process.env.PORT);',
      "http.createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1', () => {",
      '  console.log(`Local: http://localhost:${port}/`);',
      '});',
    ].join('\n'));
    mgr = createAppPreviewManager({ openExternal: async () => {} });
    const r = await mgr.start({ cwd: dir, epicId: `setsid-${process.pid}`, dir, script: 'dev' });
    expect(r.ok).toBe(true);
    let s = mgr.get(`setsid-${process.pid}`);
    for (let i = 0; i < 150 && s.status === 'starting'; i += 1) { await sleep(100); s = mgr.get(`setsid-${process.pid}`); }
    expect(s.status).toBe('running');
    grandPid = Number(fs.readFileSync(path.join(dir, 'grand.pid'), 'utf8'));
    expect(pidAlive(grandPid)).toBe(true);
    // Its own session: a kill of the preview's process group cannot reach it.
    const grandPgid = Number(fs.readFileSync(`/proc/${grandPid}/stat`, 'utf8').split(') ')[1].split(' ')[2]);
    expect(grandPgid).not.toBe(s.pid);
    await expect(mgr.stop(`setsid-${process.pid}`)).resolves.toEqual({ ok: true });
    let alive = true;
    for (let i = 0; i < 30 && alive; i += 1) {
      alive = pidAlive(grandPid);
      if (alive) await sleep(100);
    }
    expect(alive).toBe(false);
  }, 30000);
});
