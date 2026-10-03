/**
 * macroLibrary.test.cjs — Macro library store, schemas, migration, helpers.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/macroLibrary.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../macroLibrary.cjs');
const { schemas } = require('../../ipcSchemas.cjs');

let dir;
let filePath;
let opts;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macros-'));
  filePath = path.join(dir, 'macros.json');
  opts = { filePath, listPersonas: async () => [] };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const base = (o = {}) => ({
  label: 'Build the Project',
  agentName: 'builder',
  tag: 'build',
  prompt: 'Build and publish this project',
  projects: ['/work/a'],
  ...o,
});

test('create / update / delete round-trip', async () => {
  const created = await lib.saveMacro(base(), opts);
  expect(created.id).toMatch(/^build-the-project-[0-9a-f]{6}$/);
  expect(created.createdAt).toBe(created.updatedAt);
  expect(await lib.listMacros(opts)).toEqual([created]);

  await new Promise((r) => setTimeout(r, 5));
  const updated = await lib.saveMacro({ ...base({ label: 'Ship' }), id: created.id }, opts);
  expect(updated.label).toBe('Ship');
  expect(updated.createdAt).toBe(created.createdAt);
  expect(updated.updatedAt).not.toBe(created.updatedAt);

  expect(await lib.deleteMacro({ id: created.id }, opts)).toEqual({ ok: true });
  expect(await lib.deleteMacro({ id: created.id }, opts)).toEqual({ ok: true });
  expect(await lib.listMacros(opts)).toEqual([]);
});

test('update of unknown id errors', async () => {
  await expect(lib.saveMacro({ ...base(), id: 'nope' }, opts)).rejects.toThrow(/not found/);
});

test('ids are unique for identical labels', async () => {
  const a = await lib.saveMacro(base(), opts);
  const b = await lib.saveMacro(base(), opts);
  expect(a.id).not.toBe(b.id);
});

test('invalid input rejected', async () => {
  await expect(lib.saveMacro(base({ tag: 'bogus' }), opts)).rejects.toThrow();
  await expect(lib.saveMacro(base({ prompt: '   ' }), opts)).rejects.toThrow();
  await expect(lib.saveMacro(base({ projects: ['relative/path'] }), opts)).rejects.toThrow();
  await expect(lib.saveMacro(base({ label: 'x'.repeat(61) }), opts)).rejects.toThrow();
  await expect(lib.saveMacro(base({ agentName: 'Bad Name' }), opts)).rejects.toThrow();
  expect(await lib.listMacros(opts)).toEqual([]);
});

test('ipc schemas reject bad payloads and accept good ones', () => {
  expect(schemas.macrosSave.safeParse(base()).success).toBe(true);
  expect(schemas.macrosSave.safeParse(base({ projects: ['rel'] })).success).toBe(false);
  expect(schemas.macrosSave.safeParse(base({ projects: ['*'] })).success).toBe(true);
  expect(schemas.macrosDelete.safeParse({ id: '../x' }).success).toBe(false);
  expect(schemas.macrosSetProject.safeParse({ id: 'a1', cwd: '/p', enabled: true }).success).toBe(true);
  expect(schemas.macrosSetProject.safeParse({ id: 'a1', cwd: 'p', enabled: true }).success).toBe(false);
});

test('invalid entries dropped', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const good = await lib.saveMacro(base(), opts);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.macros.push({ id: 'bad', label: '' });
  fs.writeFileSync(filePath, JSON.stringify(raw));
  expect(await lib.listMacros(opts)).toEqual([good]);
  expect(warn).toHaveBeenCalled();
});

test('corrupt file is preserved, library starts empty, migration not re-run', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const listPersonas = vi.fn(async () => [{ name: 'builder', projects: ['/p'], action: 'x', tags: [] }]);
  const o = { filePath, listPersonas };
  fs.writeFileSync(filePath, '{not json');
  expect(await lib.listMacros(o)).toEqual([]);
  expect(listPersonas).not.toHaveBeenCalled();
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('macros.json.corrupt-'));
  expect(kept).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).toBe('{not json');
  expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1, macros: [] });
  expect(warn).toHaveBeenCalled();
  expect(await lib.listMacros(o)).toEqual([]);
  expect(listPersonas).not.toHaveBeenCalled();
});

test('migration seeds from personas once', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const listPersonas = vi.fn(async () => [
    { name: 'builder', projects: ['/p/one/'], action: 'Build it', actionLabel: 'Build the Project', tags: ['nonsense', 'build'], description: 'd' },
    { name: 'helper', projects: ['*'], action: null, actionLabel: null, tags: [], description: 'Helps out' },
    { name: 'noproj', projects: [], action: 'x', tags: [], description: '' },
    { name: 'noaction', projects: ['/p'], action: null, tags: [], description: '' },
    { name: 'mixed', projects: ['rel/path', '/p//two/'], action: 'Mix', tags: ['discussion', 'bug'] },
    { name: 'allrel', projects: ['rel', './x'], action: 'Nope', tags: [] },
  ]);
  const o = { filePath, listPersonas };
  const first = await lib.listMacros(o);
  expect(first).toHaveLength(3);
  expect(warn).toHaveBeenCalled();
  const mixed = first.find((m) => m.agentName === 'mixed');
  expect(mixed).toMatchObject({ tag: 'bug', projects: ['/p/two'] });
  expect(first.find((m) => m.agentName === 'allrel')).toBeUndefined();
  const b = first.find((m) => m.agentName === 'builder');
  expect(b).toMatchObject({ label: 'Build the Project', tag: 'build', prompt: 'Build it', projects: ['/p/one'] });
  const h = first.find((m) => m.agentName === 'helper');
  expect(h).toMatchObject({ label: 'helper', tag: 'discussion', prompt: 'Helps out', projects: ['*'] });

  await lib.deleteMacro({ id: b.id }, o);
  await lib.listMacros(o);
  expect(listPersonas).toHaveBeenCalledTimes(1);
});

test('migration failure writes nothing and retries next call', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let fail = true;
  const listPersonas = vi.fn(async () => {
    if (fail) throw new Error('boom');
    return [{ name: 'builder', projects: ['/p'], action: 'Build it', tags: ['build'] }];
  });
  const o = { filePath, listPersonas };
  expect(await lib.listMacros(o)).toEqual([]);
  expect(fs.existsSync(filePath)).toBe(false);
  await expect(lib.saveMacro(base(), o)).rejects.toThrow(/unavailable/);
  expect(fs.existsSync(filePath)).toBe(false);
  fail = false;
  const second = await lib.listMacros(o);
  expect(second).toHaveLength(1);
  expect(second[0].agentName).toBe('builder');
  expect(fs.existsSync(filePath)).toBe(true);
});

test('setMacroProject add / remove / wildcard', async () => {
  const m = await lib.saveMacro(base({ projects: [] }), opts);
  let r = await lib.setMacroProject({ id: m.id, cwd: '/work/b/', enabled: true }, opts);
  expect(r.ok).toBe(true);
  expect(r.macro.projects).toEqual(['/work/b']);
  r = await lib.setMacroProject({ id: m.id, cwd: '/work/b', enabled: true }, opts);
  expect(r.macro.projects).toEqual(['/work/b']);
  r = await lib.setMacroProject({ id: m.id, cwd: '/work/b/', enabled: false }, opts);
  expect(r.macro.projects).toEqual([]);

  const all = await lib.saveMacro(base({ projects: ['*'] }), opts);
  expect(await lib.setMacroProject({ id: all.id, cwd: '/x', enabled: false }, opts))
    .toEqual({ ok: false, error: 'macro is shown in every project' });
  expect((await lib.setMacroProject({ id: 'missing', cwd: '/x', enabled: true }, opts)).ok).toBe(false);
});

test('stored non-normalized project entries are normalized and removable', async () => {
  const m = await lib.saveMacro(base({ projects: [] }), opts);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  raw.macros[0].projects = ['/a/', '/b//c/'];
  fs.writeFileSync(filePath, JSON.stringify(raw));
  expect((await lib.listMacros(opts))[0].projects).toEqual(['/a', '/b/c']);
  const r = await lib.setMacroProject({ id: m.id, cwd: '/a', enabled: false }, opts);
  expect(r.macro.projects).toEqual(['/b/c']);
  const r2 = await lib.setMacroProject({ id: m.id, cwd: '/b//c/', enabled: false }, opts);
  expect(r2.macro.projects).toEqual([]);
  const saved = await lib.saveMacro({ ...base({ projects: ['/x//y/', '/x/y'] }), id: m.id }, opts);
  expect(saved.projects).toEqual(['/x/y']);
});

test('concurrent saves both persist', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => lib.saveMacro(base({ label: `m${i}` }), opts)),
  );
  const listed = await lib.listMacros(opts);
  expect(listed).toHaveLength(8);
  expect(new Set(listed.map((m) => m.id))).toEqual(new Set(results.map((m) => m.id)));
});
