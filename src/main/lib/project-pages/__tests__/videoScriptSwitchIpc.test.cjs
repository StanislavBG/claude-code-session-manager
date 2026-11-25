/**
 * videoScriptSwitchIpc.test.cjs — the human-click IPC over the 'Scripts may run
 * Demo Video' switch (videos:script-switch-get / videos:script-switch-set) over
 * a tmp SM_SCHEDULER_HOME, with the audit append captured.
 *
 * Run: timeout 300 npx vitest run src/main/lib/project-pages/__tests__/videoScriptSwitchIpc.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { schemas } = require('../../../ipcSchemas.cjs');
const vsp = require('../videoScriptPress.cjs');
const { registerVideoScriptSwitchIpc, CHANNELS } = require('../videoScriptSwitchIpc.cjs');

let home;
let proj;
let prevHome;
let handlers;
let audits;
let validated;

beforeEach(() => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-vss-ipc-')));
  proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  process.env.SM_SCHEDULER_HOME = home;
  vsp._resetForTests();
  handlers = {};
  audits = [];
  validated = [];
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  registerVideoScriptSwitchIpc(ipcMain, {
    schemas,
    validatePath: (p) => { validated.push(p); if (!path.isAbsolute(p)) throw new Error('bad path'); return p; },
    appendAuditEvent: (kind, fields) => audits.push({ kind, fields }),
  });
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const invoke = (ch, payload) => handlers[ch]({}, payload);

test('registers exactly the two channels', () => {
  expect(CHANNELS).toEqual(['videos:script-switch-get', 'videos:script-switch-set']);
  expect(Object.keys(handlers).sort()).toEqual([...CHANNELS].sort());
});

test('get defaults to off with no attribution, through validatePath', async () => {
  const res = await invoke('videos:script-switch-get', { cwd: proj });
  expect(res).toEqual({ enabled: false, changedAt: null, by: null });
  expect(validated).toEqual([proj]);
  expect(audits).toEqual([]);
});

test('set on then off records by.via ui and one audit event each', async () => {
  const on = await invoke('videos:script-switch-set', { cwd: proj, enabled: true });
  expect(on.enabled).toBe(true);
  expect(on.by).toEqual({ via: 'ui' });
  expect(typeof on.changedAt).toBe('string');
  expect(await invoke('videos:script-switch-get', { cwd: proj })).toEqual(on);
  expect(vsp.isVideoScriptSwitchOn(proj)).toBe(true);
  expect(audits).toEqual([{ kind: 'video_script_switch_changed', fields: { cwd: proj, enabled: true, via: 'ui' } }]);

  const off = await invoke('videos:script-switch-set', { cwd: proj, enabled: false });
  expect(off).toMatchObject({ enabled: false, by: { via: 'ui' } });
  expect(vsp.isVideoScriptSwitchOn(proj)).toBe(false);
  expect(audits).toHaveLength(2);
  expect(audits[1]).toEqual({ kind: 'video_script_switch_changed', fields: { cwd: proj, enabled: false, via: 'ui' } });
});

test('bad payloads are rejected before any write', async () => {
  await expect(invoke('videos:script-switch-set', { cwd: proj, enabled: 'yes' })).rejects.toThrow();
  await expect(invoke('videos:script-switch-set', { cwd: proj, enabled: true, by: { via: 'agent' } })).rejects.toThrow();
  await expect(invoke('videos:script-switch-set', { cwd: proj })).rejects.toThrow();
  await expect(invoke('videos:script-switch-get', { cwd: '' })).rejects.toThrow();
  await expect(invoke('videos:script-switch-get', { cwd: proj, extra: 1 })).rejects.toThrow();
  await expect(invoke('videos:script-switch-set', { cwd: 'relative/dir', enabled: true })).rejects.toThrow('bad path');
  expect(audits).toEqual([]);
  expect(vsp.isVideoScriptSwitchOn(proj)).toBe(false);
  expect(fs.existsSync(path.join(home, 'video-script-switches.json'))).toBe(false);
});
