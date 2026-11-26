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

test('agentsArmory accepts no cwd or a string cwd, rejects a bad cwd type and extra keys', () => {
  const s = schemas.agentsArmory;
  expect(parses(s, {})).toBe(true);
  expect(parses(s, { cwd: '/work/alpha' })).toBe(true);
  expect(parses(s, { cwd: 5 })).toBe(false);
  expect(parses(s, { cwd: '/w', extra: 1 })).toBe(false);
});

test('agentsIpc agents:armory calls buildArmory with the cwd and the scheduler banned tools', async () => {
  const armory = require('../lib/claude/agentArmory.cjs');
  const spy = vi.spyOn(armory, 'buildArmory').mockResolvedValue({ builtins: [] });
  const handlers = new Map();
  registerAgentsHandlers({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, getWindow: () => null });
  const res = await handlers.get('agents:armory')({}, { cwd: '/work/alpha' });
  expect(res).toEqual({ builtins: [] });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][0].cwd).toBe('/work/alpha');
  expect(Array.isArray(spy.mock.calls[0][0].deps.bannedTools)).toBe(true);
});

test('agentsSavePersona admits gear keys on global and override saves and validates them', () => {
  const s = schemas.agentsSavePersona;
  const base = { name: 'dev-lead', description: '', tools: [], model: 'opus', color: '', tags: [], body: '' };
  expect(parses(s, { ...base, projectCwd: '/work/alpha', mcpServers: ['a'], packs: ['p'], environment: 'sandboxed', loadout: 'bare' })).toBe(true);
  // Global save (no projectCwd): every gear field is accepted and kept.
  const g = s.safeParse({ ...base, mcpServers: ['a'], packs: [], environment: 'sandboxed', loadout: 'unbound' });
  expect(g.success).toBe(true);
  expect(g.data).toMatchObject({ mcpServers: ['a'], packs: [], environment: 'sandboxed', loadout: 'unbound' });
  expect(parses(s, { ...base, mcpServers: [] })).toBe(true);
  expect(parses(s, { ...base, packs: ['p'] })).toBe(true);
  expect(parses(s, { ...base, loadout: 'bare' })).toBe(true);
  expect(parses(s, { ...base, loadout: 'equipped' })).toBe(true);
  expect(parses(s, { ...base, loadout: 'undecided' })).toBe(false);
  expect(parses(s, { ...base, loadout: 'nope' })).toBe(false);
  expect(parses(s, { ...base, environment: 'Bad Env' })).toBe(false);
  expect(parses(s, { ...base, mcpServers: [''] })).toBe(false);
  expect(parses(s, { ...base, projectCwd: '/work/alpha', environment: 'Bad Env' })).toBe(false);
  expect(parses(s, { ...base, projectCwd: '/work/alpha', bogus: 1 })).toBe(false);
});

test('agentsTakeBundledPersona accepts a bare name; rejects extra key and traversal name', () => {
  const s = schemas.agentsTakeBundledPersona;
  expect(parses(s, { name: 'dev-lead' })).toBe(true);
  expect(parses(s, { name: 'dev-lead', extra: 1 })).toBe(false);
  expect(parses(s, { name: '../x' })).toBe(false);
});

test('agentsDismissPersonaUpgrade accepts name + integer version >= 1; rejects extra key, traversal, 0 and 1.5', () => {
  const s = schemas.agentsDismissPersonaUpgrade;
  expect(parses(s, { name: 'dev-lead', bundledVersion: 2 })).toBe(true);
  expect(parses(s, { name: 'dev-lead', bundledVersion: 2, extra: 1 })).toBe(false);
  expect(parses(s, { name: '../x', bundledVersion: 2 })).toBe(false);
  expect(parses(s, { name: 'dev-lead', bundledVersion: 0 })).toBe(false);
  expect(parses(s, { name: 'dev-lead', bundledVersion: 1.5 })).toBe(false);
});

test('agentsIpc persona upgrade channels call personaUpgrade then broadcast agents:changed', async () => {
  const pu = require('../lib/persona-macro/personaUpgrade.cjs');
  const take = vi.spyOn(pu, 'takeBundledPersona').mockResolvedValue({ seedVersion: 2 });
  const dismiss = vi.spyOn(pu, 'dismissPersonaUpgrade').mockResolvedValue(undefined);
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (c) => sent.push(c) } };
  registerAgentsHandlers({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, getWindow: () => win });
  await handlers.get('agents:take-bundled-persona')({}, { name: 'dev-lead' });
  await handlers.get('agents:dismiss-persona-upgrade')({}, { name: 'dev-lead', bundledVersion: 3 });
  expect(take).toHaveBeenCalledWith('dev-lead');
  expect(dismiss).toHaveBeenCalledWith('dev-lead', 3);
  expect(sent).toEqual(['agents:changed', 'agents:changed']);
});
