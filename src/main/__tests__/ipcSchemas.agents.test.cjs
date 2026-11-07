/**
 * ipcSchemas.agents.test.cjs — boundary schemas for the Agent Library's two
 * delete channels (`agents:remove-override`, `agents:delete-persona`), and
 * agentsIpc.cjs routing both through them before agentLibrary touches disk.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/ipcSchemas.agents.test.cjs
 */

'use strict';

import { test, expect, vi, afterEach } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');
const agentLibrary = require('../agentLibrary.cjs');
const { registerAgentsHandlers } = require('../agentsIpc.cjs');

const parses = (schema, payload) => schema.safeParse(payload).success;

afterEach(() => vi.restoreAllMocks());

test('agentsRemoveOverride rejects the retired projectName key, a relative cwd and a traversal name; accepts name + absolute projectCwd', () => {
  const s = schemas.agentsRemoveOverride;
  expect(parses(s, { name: 'dev-lead', projectName: 'alpha' })).toBe(false);
  expect(parses(s, { name: 'dev-lead', projectCwd: 'work/alpha' })).toBe(false);
  expect(parses(s, { name: '../x', projectCwd: '/work/alpha' })).toBe(false);
  expect(parses(s, { name: 'dev-lead', projectCwd: '/work/alpha' })).toBe(true);
});

test('agentsDeletePersona rejects a traversal name and an extra key; accepts a bare persona name', () => {
  const s = schemas.agentsDeletePersona;
  expect(parses(s, { name: '../../x' })).toBe(false);
  // globalDir is a real deletePersona parameter — an unchecked payload could redirect the unlink.
  expect(parses(s, { name: 'dev-lead', globalDir: '/tmp' })).toBe(false);
  expect(parses(s, { name: 'dev-lead' })).toBe(true);
});

test('agentsIpc validates both delete channels before agentLibrary runs, and broadcasts agents:changed after each write', async () => {
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel) => sent.push(channel) } };
  registerAgentsHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, getWindow: () => win });
  const del = vi.spyOn(agentLibrary, 'deletePersona').mockResolvedValue({ ok: true });
  const rm = vi.spyOn(agentLibrary, 'removeOverride').mockResolvedValue({ ok: true });

  expect(() => handlers.get('agents:delete-persona')({}, { name: '../../x' })).toThrow(/agent name must be lowercase/);
  expect(() => handlers.get('agents:remove-override')({}, { name: 'dev-lead', projectName: 'alpha' })).toThrow();
  expect(del).not.toHaveBeenCalled();
  expect(rm).not.toHaveBeenCalled();
  expect(sent).toEqual([]);

  await expect(handlers.get('agents:delete-persona')({}, { name: 'dev-lead' })).resolves.toEqual({ ok: true });
  await expect(handlers.get('agents:remove-override')({}, { name: 'dev-lead', projectCwd: '/work/alpha' })).resolves.toEqual({ ok: true });
  expect(del).toHaveBeenCalledWith({ name: 'dev-lead' });
  expect(rm).toHaveBeenCalledWith({ name: 'dev-lead', projectCwd: '/work/alpha' });
  expect(sent).toEqual(['agents:changed', 'agents:changed']);
});
