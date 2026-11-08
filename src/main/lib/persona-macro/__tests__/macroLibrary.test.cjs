/**
 * macroLibrary.test.cjs — Macro library store, schemas, migration, helpers.
 *
 * Run: timeout 300 npx vitest run src/main/lib/persona-macro/__tests__/macroLibrary.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../macroLibrary.cjs');
const { schemas } = require('../../../ipcSchemas.cjs');

let dir;
let filePath;
let opts;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macros-'));
  filePath = path.join(dir, 'macros.json');
  // builtins: [] keeps existing tests' expectations unaffected by the seeded
  // built-in macros (covered separately below).
  opts = { filePath, listPersonas: async () => [], builtins: [] };
});
afterEach(() => {
  vi.useRealTimers();
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

test('portfolio tag round-trips', async () => {
  const saved = await lib.saveMacro(
    base({ label: 'Portfolio Optimization', tag: 'portfolio', prompt: 'x' }),
    opts,
  );
  expect(saved.tag).toBe('portfolio');
  const reloaded = (await lib.listMacros(opts)).find((m) => m.id === saved.id);
  expect(reloaded.tag).toBe('portfolio');
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
  const o = { filePath, listPersonas, builtins: [] };
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
  const o = { filePath, listPersonas, builtins: [] };
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
  const o = { filePath, listPersonas, builtins: [] };
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

// --- surface + builtins -----------------------------------------------------

const TEST_BUILTINS_V1 = Object.freeze([
  Object.freeze({
    id: 'builtin-test-one',
    label: 'Test One',
    agentName: 'test-builder',
    tag: 'build',
    surface: 'project-home',
    projects: ['*'],
    builtinVersion: 1,
    prompt: 'v1 prompt',
  }),
]);

const TEST_BUILTINS_V2 = Object.freeze([
  { ...TEST_BUILTINS_V1[0], label: 'Test One v2', prompt: 'v2 prompt', builtinVersion: 2 },
]);

test('surface defaults to sessions and round-trips', async () => {
  const created = await lib.saveMacro(base(), opts);
  expect(created.surface).toBe('sessions');
  const listed = await lib.listMacros(opts);
  expect(listed.find((m) => m.id === created.id).surface).toBe('sessions');

  const updated = await lib.saveMacro({ ...base({ label: 'Ship' }), id: created.id, surface: 'project-home' }, opts);
  expect(updated.surface).toBe('project-home');
  const keep = await lib.saveMacro({ ...base({ label: 'Ship2' }), id: created.id }, opts);
  expect(keep.surface).toBe('project-home');
});

test('builtin flag cannot be set via saveMacro', async () => {
  const created = await lib.saveMacro({ ...base(), builtin: true }, opts);
  expect(created.builtin).toBeUndefined();
});

test('built-in surface cannot be changed; same-surface save is ok', async () => {
  const o = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await lib.listMacros(o);
  const b = { label: 'Test One', agentName: 'test-builder', tag: 'build', prompt: 'v1 prompt', id: 'builtin-test-one' };
  await expect(lib.saveMacro({ ...b, surface: 'sessions' }, o)).rejects.toThrow('built-in macro surface cannot be changed');
  const same = await lib.saveMacro({ ...b, surface: 'project-home' }, o);
  expect(same.surface).toBe('project-home');
  const none = await lib.saveMacro(b, o);
  expect(none.surface).toBe('project-home');
});

test('seeds built-ins into a missing store', async () => {
  const o = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  const listed = await lib.listMacros(o);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    id: 'builtin-test-one',
    label: 'Test One',
    prompt: 'v1 prompt',
    surface: 'project-home',
    builtin: true,
    builtinVersion: 1,
  });
  expect(listed[0].createdAt).toBe(listed[0].updatedAt);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(onDisk.macros).toHaveLength(1);
});

test('seeds built-ins into an existing store that lacks them', async () => {
  const createdUser = await lib.saveMacro(base(), opts);
  const o = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  const listed = await lib.listMacros(o);
  expect(listed).toHaveLength(2);
  expect(listed.map((m) => m.id).sort()).toEqual([createdUser.id, 'builtin-test-one'].sort());
});

test('no double seed under concurrent listMacros', async () => {
  const o = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await Promise.all([lib.listMacros(o), lib.listMacros(o), lib.listMacros(o)]);
  const listed = await lib.listMacros(o);
  expect(listed).toHaveLength(1);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(onDisk.macros).toHaveLength(1);
});

test('upgrades an unedited built-in to the shipped version', async () => {
  const oV1 = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await lib.listMacros(oV1);
  const oV2 = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V2 };
  const listed = await lib.listMacros(oV2);
  const upgraded = listed.find((m) => m.id === 'builtin-test-one');
  expect(upgraded).toMatchObject({ label: 'Test One v2', prompt: 'v2 prompt', builtinVersion: 2 });
  expect(upgraded.createdAt).toBe(upgraded.updatedAt);
});

test('leaves a user-edited built-in untouched', async () => {
  const oV1 = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await lib.listMacros(oV1);
  await new Promise((r) => setTimeout(r, 5));
  const edited = await lib.saveMacro({ ...base({ label: 'My Custom Label' }), id: 'builtin-test-one' }, oV1);
  expect(edited.createdAt).not.toBe(edited.updatedAt);

  const oV2 = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V2 };
  const listed = await lib.listMacros(oV2);
  const stillEdited = listed.find((m) => m.id === 'builtin-test-one');
  expect(stillEdited).toMatchObject({ label: 'My Custom Label', builtinVersion: 1 });
});

// --- content-based upgrade (timestamps alone never prove an edit) ------------

const TEST_BUILTINS_V2_HISTORY = Object.freeze([
  { ...TEST_BUILTINS_V1[0], prompt: 'v2 prompt', builtinVersion: 2, priorPrompts: ['v1 prompt'] },
]);
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';

function seedStored(over) {
  const b = TEST_BUILTINS_V1[0];
  const stored = {
    id: b.id,
    label: b.label,
    agentName: b.agentName,
    tag: b.tag,
    prompt: b.prompt,
    projects: ['*'],
    surface: b.surface,
    builtin: true,
    builtinVersion: 1,
    createdAt: T0,
    updatedAt: T1,
    ...over,
  };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [stored] }));
  return stored;
}
const histOpts = () => ({ filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V2_HISTORY });

test('a re-stamped built-in holding an earlier shipped prompt still upgrades', async () => {
  seedStored();
  const listed = await lib.listMacros(histOpts());
  const m = listed.find((x) => x.id === 'builtin-test-one');
  expect(m).toMatchObject({ prompt: 'v2 prompt', builtinVersion: 2 });
  expect(m.updatedAt).toBe(m.createdAt);
});

test('an unchanged Save through saveMacro does not stop the next upgrade', async () => {
  const stored = seedStored({ updatedAt: T0 });
  const o1 = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await lib.saveMacro(
    {
      id: stored.id,
      label: stored.label,
      agentName: stored.agentName,
      tag: stored.tag,
      prompt: stored.prompt,
      projects: stored.projects,
    },
    o1,
  );
  const listed = await lib.listMacros(histOpts());
  const m = listed.find((x) => x.id === 'builtin-test-one');
  expect(m).toMatchObject({ prompt: 'v2 prompt', builtinVersion: 2 });
});

test('an upgrade widens project-home projects, keeps autoStartTargets, and drops inputs the built-in no longer declares', async () => {
  const inputs = [{ name: 'x', label: 'X' }];
  const autoStartTargets = ['/tmp/some-project'];
  seedStored({ projects: ['/a', '/b'], inputs, autoStartTargets });
  const listed = await lib.listMacros(histOpts());
  const m = listed.find((x) => x.id === 'builtin-test-one');
  expect(m.prompt).toBe('v2 prompt');
  // A project-home macro is shown in every project, so narrowed projects are widened.
  expect(m.projects).toEqual(['*']);
  expect(m.inputs).toBeUndefined();
  expect(m.autoStartTargets).toEqual(autoStartTargets);
});

test('a built-in with a really edited prompt stays frozen', async () => {
  seedStored({ prompt: 'my own prompt' });
  const listed = await lib.listMacros(histOpts());
  expect(listed.find((x) => x.id === 'builtin-test-one')).toMatchObject({
    prompt: 'my own prompt',
    builtinVersion: 1,
  });
});

test('a built-in with an edited label stays frozen even when its prompt shipped', async () => {
  seedStored({ label: 'Renamed' });
  const listed = await lib.listMacros(histOpts());
  expect(listed.find((x) => x.id === 'builtin-test-one')).toMatchObject({
    label: 'Renamed',
    prompt: 'v1 prompt',
    builtinVersion: 1,
  });
});

test('every real built-in lists one prior prompt per earlier version', () => {
  const { BUILTIN_MACROS } = require('../builtinMacros.cjs');
  for (const b of BUILTIN_MACROS) {
    expect(Array.isArray(b.priorPrompts)).toBe(true);
    expect(Object.isFrozen(b.priorPrompts)).toBe(true);
    expect(b.builtinVersion).toBe(b.priorPrompts.length + 1);
    expect(b.priorPrompts).not.toContain(b.prompt);
  }
});

test('the real demo-video v2 copy with a late updatedAt upgrades to the shipped prompt', async () => {
  const { BUILTIN_MACROS } = require('../builtinMacros.cjs');
  const real = BUILTIN_MACROS.find((b) => b.id === 'builtin-demo-video');
  seedStored({
    id: real.id,
    label: real.label,
    agentName: real.agentName,
    tag: real.tag,
    prompt: real.priorPrompts[1],
    builtinVersion: 2,
    createdAt: '2026-10-03T19:04:10.519Z',
    updatedAt: '2026-10-03T19:35:19.725676Z',
  });
  const listed = await lib.listMacros({ filePath, listPersonas: async () => [], builtins: BUILTIN_MACROS });
  const m = listed.find((x) => x.id === real.id);
  expect(m.builtinVersion).toBe(real.builtinVersion);
  expect(m.prompt).toBe(real.prompt);
});

test('the real demo-video v4 copy with a late updatedAt upgrades to the current version', async () => {
  const { BUILTIN_MACROS } = require('../builtinMacros.cjs');
  const real = BUILTIN_MACROS.find((b) => b.id === 'builtin-demo-video');
  seedStored({
    id: real.id,
    label: real.label,
    agentName: real.agentName,
    tag: real.tag,
    prompt: real.priorPrompts[3],
    builtinVersion: 4,
    createdAt: '2026-10-03T19:04:10.519Z',
    updatedAt: '2026-10-04T19:35:19.725Z',
  });
  const listed = await lib.listMacros({ filePath, listPersonas: async () => [], builtins: BUILTIN_MACROS });
  const m = listed.find((x) => x.id === real.id);
  expect(m.builtinVersion).toBe(real.builtinVersion);
  expect(m.prompt).toBe(real.prompt);
});

test('re-stamped project-home v2 and demo-video v6 copies upgrade to v3 and v7', async () => {
  const { BUILTIN_MACROS } = require('../builtinMacros.cjs');
  for (const [id, shipped, next] of [['builtin-project-home', 2, 3], ['builtin-demo-video', 6, 7]]) {
    const real = BUILTIN_MACROS.find((b) => b.id === id);
    expect(typeof real.priorPrompts[shipped - 1]).toBe('string');
    seedStored({
      id: real.id,
      label: real.label,
      agentName: real.agentName,
      tag: real.tag,
      surface: real.surface,
      prompt: real.priorPrompts[shipped - 1],
      builtinVersion: shipped,
      createdAt: '2026-10-03T19:04:10.519Z',
      updatedAt: '2026-11-06T19:35:19.725Z',
    });
    const listed = await lib.listMacros({ filePath, listPersonas: async () => [], builtins: BUILTIN_MACROS });
    const m = listed.find((x) => x.id === real.id);
    expect(m.builtinVersion).toBe(next);
    expect(m.prompt).toBe(real.prompt);
  }
});

test('built-in macros cannot be deleted', async () => {
  const o = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await lib.listMacros(o);
  await expect(lib.deleteMacro({ id: 'builtin-test-one' }, o)).rejects.toThrow(/built-in macros cannot be deleted/);
});

test('setMacroProject on a built-in keeps the wildcard behaviour', async () => {
  const o = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await lib.listMacros(o);
  const r = await lib.setMacroProject({ id: 'builtin-test-one', cwd: '/x', enabled: false }, o);
  expect(r).toEqual({ ok: false, error: 'macro is shown in every project' });
});

test('real BUILTIN_MACROS seed as expected', async () => {
  const o = { filePath, listPersonas: async () => [] };
  const listed = await lib.listMacros(o);
  expect(listed.map((m) => m.id).sort()).toEqual(['builtin-competitor-matrix', 'builtin-demo-video', 'builtin-project-home', 'builtin-review-md-network']);
  const projectHome = listed.find((m) => m.id === 'builtin-project-home');
  expect(projectHome).toMatchObject({ label: 'Project Home', agentName: 'project-home-builder', tag: 'project-home-builder', surface: 'project-home' });
});

// ── inputs ──────────────────────────────────────────────────────────────────

const withInputs = (o = {}) => base({
  prompt: 'Run stream={{stream}}',
  inputs: [{ name: 'stream', label: 'Stream', default: 'education-veggies' }],
  ...o,
});

test('inputs: create round-trips through listMacros; absent when not given', async () => {
  const created = await lib.saveMacro(withInputs(), opts);
  expect(created.inputs).toEqual([{ name: 'stream', label: 'Stream', default: 'education-veggies' }]);
  expect(await lib.listMacros(opts)).toEqual([created]);
  const plain = await lib.saveMacro(base(), opts);
  expect('inputs' in plain).toBe(false);
});

test('inputs: update with inputs omitted preserves them; [] clears them', async () => {
  const created = await lib.saveMacro(withInputs(), opts);
  const kept = await lib.saveMacro({ ...base({ label: 'Renamed', prompt: 'Run stream={{stream}}' }), id: created.id }, opts);
  expect(kept.inputs).toEqual(created.inputs);
  const cleared = await lib.saveMacro({ ...base({ prompt: 'No args' }), id: created.id, inputs: [] }, opts);
  expect('inputs' in cleared).toBe(false);
  expect('inputs' in (await lib.listMacros(opts))[0]).toBe(false);
});

test('inputs: undeclared placeholder rejected, naming it', async () => {
  await expect(lib.saveMacro(withInputs({ prompt: 'a {{stream}} b {{other}}' }), opts)).rejects.toThrow(/other/);
});

test('inputs: merged-macro check rejects undeclared placeholders on every save path', async () => {
  // create with no inputs
  await expect(lib.saveMacro(base({ prompt: 'Run {{x}}' }), opts)).rejects.toThrow('prompt placeholder {{x}} is not declared in inputs');
  expect(await lib.listMacros(opts)).toEqual([]);

  const created = await lib.saveMacro(withInputs(), opts);
  const before = await lib.listMacros(opts);

  // update with inputs: [] while the prompt keeps {{stream}}
  await expect(lib.saveMacro({ ...withInputs(), id: created.id, inputs: [] }, opts)).rejects.toThrow(/\{\{stream\}\}/);
  expect(await lib.listMacros(opts)).toEqual(before);

  // update with inputs omitted, new prompt adds {{other}}
  await expect(lib.saveMacro({ ...base({ prompt: 'Run {{stream}} {{other}}' }), id: created.id }, opts)).rejects.toThrow(/\{\{other\}\}/);
  expect(await lib.listMacros(opts)).toEqual(before);

  // omitted inputs with only stored inputs is accepted
  const ok = await lib.saveMacro({ ...base({ prompt: 'Again {{stream}}' }), id: created.id }, opts);
  expect(ok.inputs).toEqual(created.inputs);
});

test('inputs: duplicate name rejected', async () => {
  const dup = [{ name: 'stream', label: 'A' }, { name: 'stream', label: 'B' }];
  await expect(lib.saveMacro(withInputs({ inputs: dup }), opts)).rejects.toThrow(/duplicate/);
});

test('inputs: default outside options rejected', async () => {
  const bad = [{ name: 'stream', label: 'S', default: 'x', options: ['a', 'b'] }];
  await expect(lib.saveMacro(withInputs({ inputs: bad }), opts)).rejects.toThrow(/options/);
});

test('inputs: stored legacy macro with literal {{x}} and no inputs still lists', async () => {
  const now = new Date().toISOString();
  const legacy = {
    id: 'legacy', label: 'Legacy', agentName: 'builder', tag: 'build',
    prompt: 'literal {{x}} here', projects: ['/work/a'], surface: 'sessions',
    createdAt: now, updatedAt: now,
  };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [legacy] }));
  const listed = await lib.listMacros(opts);
  expect(listed.map((m) => m.id)).toEqual(['legacy']);
});

const PORTFOLIO_INPUTS = [
  { name: 'mode', label: 'Mode', default: 'auto', required: true, options: ['auto', 'early-check', 'review'] },
  { name: 'focus', label: 'Focus (tool, project or question; optional)', default: 'none', required: false },
  { name: 'instructions', label: 'Instructions for Bilko (verbatim; optional)', default: 'none', required: false },
  { name: 'data', label: 'New data or links since last review (optional)', default: 'none', required: false },
];
const PORTFOLIO_PROMPT = 'Owner inputs for this run:\n- Mode: {{mode}}\n- Focus: {{focus}}\n- Instructions: {{instructions}}\n- Data / links: {{data}}';

test('renderMacroPrompt: Portfolio with {} renders defaults', () => {
  const r = lib.renderMacroPrompt(PORTFOLIO_PROMPT, PORTFOLIO_INPUTS, {});
  expect(r).toEqual({
    ok: true,
    prompt: 'Owner inputs for this run:\n- Mode: auto\n- Focus: none\n- Instructions: none\n- Data / links: none',
  });
  expect(r.prompt).not.toContain('{{');
});

test('renderMacroPrompt: Portfolio with supplied values', () => {
  const r = lib.renderMacroPrompt(PORTFOLIO_PROMPT, PORTFOLIO_INPUTS, { mode: 'review', focus: 'Bilko' });
  expect(r).toEqual({
    ok: true,
    prompt: 'Owner inputs for this run:\n- Mode: review\n- Focus: Bilko\n- Instructions: none\n- Data / links: none',
  });
});

test('renderMacroPrompt: bogus option rejected', () => {
  expect(lib.renderMacroPrompt(PORTFOLIO_PROMPT, PORTFOLIO_INPUTS, { mode: 'bogus' })).toEqual({
    ok: false,
    error: '"Mode" must be one of: auto, early-check, review',
  });
});

test('renderMacroPrompt: strict when no inputs declared', () => {
  const err = { ok: false, error: 'prompt uses undeclared input {{x}}' };
  expect(lib.renderMacroPrompt('keep {{x}}', undefined, {})).toEqual(err);
  expect(lib.renderMacroPrompt('keep {{x}}', [], {})).toEqual(err);
  expect(lib.renderMacroPrompt('plain text', undefined, {})).toEqual({ ok: true, prompt: 'plain text' });
});

test('renderMacroPrompt: only own string values are read', () => {
  const inputs = [{ name: 'constructor', label: 'C', default: 'd' }];
  expect(lib.renderMacroPrompt('v={{constructor}}', inputs, {})).toEqual({ ok: true, prompt: 'v=d' });
});

test('macroPlaceholders / defaultMacroValues', () => {
  expect(lib.macroPlaceholders('{{b}} {{a}} {{b}}')).toEqual(['b', 'a']);
  expect(lib.defaultMacroValues([{ name: 'a', label: 'A', default: 'x' }, { name: 'b', label: 'B' }])).toEqual({ a: 'x', b: '' });
});

test('macroVisibleIn', () => {
  expect(lib.macroVisibleIn({ projects: ['*'] }, '/work/a')).toBe(true);
  expect(lib.macroVisibleIn({ projects: ['/work/a'] }, '/work/a')).toBe(true);
  expect(lib.macroVisibleIn({ projects: ['/work/a'] }, '/work/a/')).toBe(true);
  expect(lib.macroVisibleIn({ projects: ['/work/a'] }, '/work/b')).toBe(false);
  expect(lib.macroVisibleIn({ projects: [] }, '/work/a')).toBe(false);
});

test('autoStartTargets: create stores normalized non-empty list, empty/omitted leaves absent', async () => {
  const a = await lib.saveMacro(base({ autoStartTargets: ['/work/b/', '*', '/work/b'] }), opts);
  expect(a.autoStartTargets).toEqual(['/work/b', '*']);
  const b = await lib.saveMacro(base({ autoStartTargets: [] }), opts);
  expect('autoStartTargets' in b).toBe(false);
  const c = await lib.saveMacro(base(), opts);
  expect('autoStartTargets' in c).toBe(false);
});

test('autoStartTargets: update omitted keeps, [] deletes, non-empty replaces; survives file round trip', async () => {
  const a = await lib.saveMacro(base({ autoStartTargets: ['/work/b'] }), opts);
  const kept = await lib.saveMacro(base({ id: a.id }), opts);
  expect(kept.autoStartTargets).toEqual(['/work/b']);
  const replaced = await lib.saveMacro(base({ id: a.id, autoStartTargets: ['/work/c'] }), opts);
  expect(replaced.autoStartTargets).toEqual(['/work/c']);
  const onDisk = (await lib.listMacros(opts)).find((m) => m.id === a.id);
  expect(onDisk.autoStartTargets).toEqual(['/work/c']);
  expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).macros.find((m) => m.id === a.id).autoStartTargets).toEqual(['/work/c']);
  const cleared = await lib.saveMacro(base({ id: a.id, autoStartTargets: [] }), opts);
  expect('autoStartTargets' in cleared).toBe(false);
  const reread = (await lib.listMacros(opts)).find((m) => m.id === a.id);
  expect('autoStartTargets' in reread).toBe(false);
});

test('autoStartTargets rejects relative paths', async () => {
  await expect(lib.saveMacro(base({ autoStartTargets: ['rel/dir'] }), opts)).rejects.toThrow();
});

test('macroAllowsAutoStart', () => {
  expect(lib.macroAllowsAutoStart({ autoStartTargets: ['/work/b'] }, '/work/b/')).toBe(true);
  expect(lib.macroAllowsAutoStart({ autoStartTargets: ['/work/b'] }, '/work/c')).toBe(false);
  expect(lib.macroAllowsAutoStart({ autoStartTargets: ['*'] }, '/anything')).toBe(true);
  expect(lib.macroAllowsAutoStart({ autoStartTargets: [] }, '/work/b')).toBe(false);
  expect(lib.macroAllowsAutoStart({}, '/work/b')).toBe(false);
  expect(lib.macroAllowsAutoStart(null, '/work/b')).toBe(false);
});

// --- removeMacroFromProject --------------------------------------------------

test('removeMacroFromProject rejects malformed input', async () => {
  await expect(lib.removeMacroFromProject({ id: '', cwd: '/a' }, opts)).rejects.toThrow();
  await expect(lib.removeMacroFromProject({ id: 'x', cwd: 'rel/path' }, opts)).rejects.toThrow();
});

test('removeMacroFromProject deletes when cwd was the last project', async () => {
  const m = await lib.saveMacro(base({ projects: ['/a'] }), opts);
  const r = await lib.removeMacroFromProject({ id: m.id, cwd: '/a' }, opts);
  expect(r).toEqual({ ok: true, deleted: true, macro: m });
  expect(await lib.listMacros(opts)).toEqual([]);
});

test('removeMacroFromProject drops only cwd when others remain', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  const m = await lib.saveMacro(base({ projects: ['/a', '/b'] }), opts);
  vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
  const r = await lib.removeMacroFromProject({ id: m.id, cwd: '/a/' }, opts);
  expect(r.ok).toBe(true);
  expect(r.deleted).toBe(false);
  expect(r.macro.projects).toEqual(['/b']);
  expect(r.macro.updatedAt).toBe('2026-01-01T00:00:01.000Z');
  expect(r.macro).toEqual({ ...m, projects: ['/b'], updatedAt: r.macro.updatedAt });
  expect(await lib.listMacros(opts)).toEqual([r.macro]);
});

test('removeMacroFromProject refusals leave macros.json byte-identical', async () => {
  const one = await lib.saveMacro(base({ projects: ['/a'] }), opts);
  const all = await lib.saveMacro(base({ label: 'Everywhere', projects: ['*'] }), opts);
  const none = await lib.saveMacro(base({ label: 'Nowhere', projects: [] }), opts);
  const before = fs.readFileSync(filePath);
  const cases = [
    [{ id: 'missing', cwd: '/a' }, 'macro not found: missing'],
    [{ id: all.id, cwd: '/a' }, `macro ${all.id} is shown in every project; only the human can remove it, from the HOT KEYS panel`],
    [{ id: one.id, cwd: '/zzz' }, `macro ${one.id} is not visible to /zzz`],
    [{ id: none.id, cwd: '/a' }, `macro ${none.id} is not visible to /a`],
  ];
  for (const [input, error] of cases) {
    expect(await lib.removeMacroFromProject(input, opts)).toEqual({ ok: false, error });
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  }
});

test('removeMacroFromProject refuses a built-in', async () => {
  const o = { filePath, listPersonas: async () => [], builtins: TEST_BUILTINS_V1 };
  await lib.listMacros(o);
  const before = fs.readFileSync(filePath);
  expect(await lib.removeMacroFromProject({ id: 'builtin-test-one', cwd: '/a' }, o))
    .toEqual({ ok: false, error: 'built-in macros cannot be deleted' });
  expect(fs.readFileSync(filePath).equals(before)).toBe(true);
});

test('removeMacroFromProject and saveMacro run concurrently without loss', async () => {
  const m = await lib.saveMacro(base({ projects: ['/a'] }), opts);
  const [r, created] = await Promise.all([
    lib.removeMacroFromProject({ id: m.id, cwd: '/a' }, opts),
    lib.saveMacro(base({ label: 'Other', projects: ['/c'] }), opts),
  ]);
  expect(r.ok).toBe(true);
  expect(await lib.listMacros(opts)).toEqual([created]);
});

test('listMacros returns job on built-in entries, live, even for an edited stored copy', async () => {
  const { BUILTIN_MACROS } = require('../builtinMacros.cjs');
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const stored = {
    id: demo.id, label: 'Edited', agentName: demo.agentName, tag: demo.tag, prompt: 'my own prompt',
    projects: ['*'], surface: 'project-home', builtin: true, builtinVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z',
    job: { estimateMinutes: 1, artifactPaths: ['x'] },
  };
  const user = { ...stored, id: 'user-one', builtin: undefined, job: { estimateMinutes: 1, artifactPaths: ['x'] } };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [stored, user] }));
  const list = await lib.listMacros(opts);
  expect(list.find((m) => m.id === demo.id).job).toEqual(demo.job);
  expect('job' in list.find((m) => m.id === 'user-one')).toBe(false);
  // never persisted
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(onDisk.macros.every((m) => !('job' in m) || m.job.estimateMinutes === 1)).toBe(true);
});

test('saveMacro never writes a job key', async () => {
  const created = await lib.saveMacro({ ...base(), job: { estimateMinutes: 5, artifactPaths: ['a'] } }, opts);
  expect('job' in created).toBe(false);
  await lib.saveMacro({ ...base(), id: created.id, job: { estimateMinutes: 5, artifactPaths: ['a'] } }, opts);
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expect(onDisk.macros.some((m) => 'job' in m)).toBe(false);
});

// --- built-in inputs + supersedes -------------------------------------------

const inBuiltin = (o = {}) => ({
  id: 'bi-inputs', label: 'Inputs', agentName: 'builder', tag: 'build',
  prompt: 'Do {{kind}} work', projects: ['*'], surface: 'project-home', builtinVersion: 1,
  inputs: [{ name: 'kind', label: 'Kind', options: ['a', 'b'], default: 'a' }],
  ...o,
});

test('ensureBuiltins seeds inputs as a deep copy that renders', () => {
  const b = inBuiltin();
  const { macros } = lib.ensureBuiltins([], [b]);
  const m = macros[0];
  expect(m.inputs).toEqual(b.inputs);
  expect(m.inputs).not.toBe(b.inputs);
  expect(m.inputs[0].options).not.toBe(b.inputs[0].options);
  expect(lib.MacroSchema.safeParse(m).success).toBe(true);
  expect(lib.renderMacroPrompt(m.prompt, m.inputs, lib.defaultMacroValues(m.inputs)).ok).toBe(true);
});

test('ensureBuiltins upgrade replaces/deletes inputs only on unedited copies', () => {
  const v1 = lib.ensureBuiltins([], [inBuiltin()]).macros;
  const up = lib.ensureBuiltins(v1, [inBuiltin({ builtinVersion: 2, prompt: 'Plain', inputs: undefined })]);
  expect(up.changed).toBe(true);
  expect('inputs' in up.macros[0]).toBe(false);
  const up2 = lib.ensureBuiltins(v1, [inBuiltin({ builtinVersion: 2, inputs: [{ name: 'kind', label: 'K' }] })]);
  expect(up2.macros[0].inputs).toEqual([{ name: 'kind', label: 'K' }]);
  const edited = [{ ...v1[0], prompt: 'mine {{kind}}', updatedAt: '2099-01-01T00:00:00.000Z' }];
  const kept = lib.ensureBuiltins(edited, [inBuiltin({ builtinVersion: 2, inputs: undefined })]);
  expect(kept.macros[0].inputs).toEqual(v1[0].inputs);
});

test('supersedes retires non-builtin macros on first seed only', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const mk = (id, builtin) => ({ ...base(), id, createdAt: 't', updatedAt: 't', ...(builtin ? { builtin: true, builtinVersion: 1 } : {}) });
  const stored = [mk('old-one'), mk('old-builtin', true), mk('keep')];
  const b = inBuiltin({ supersedes: ['old-one', 'old-builtin'] });
  const r = lib.ensureBuiltins(stored, [b]);
  expect(r.retired).toEqual(['old-one']);
  expect(r.macros.map((m) => m.id).sort()).toEqual(['bi-inputs', 'keep', 'old-builtin']);
  // already stored: no-op, nothing removed
  const again = lib.ensureBuiltins([...r.macros, mk('old-one')], [b]);
  expect(again.changed).toBe(false);
  expect(again.retired).toEqual([]);
  expect(again.macros.some((m) => m.id === 'old-one')).toBe(true);
  // applyBuiltins logs per retired id
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [mk('old-one')] }));
  await lib.listMacros({ ...opts, builtins: [b] });
  expect(info).toHaveBeenCalledWith('[macroLibrary] retired macro old-one, superseded by built-in bi-inputs');
});

// --- project-home macros are shown in every project -------------------------

const PH_STAMP = '2026-01-01T00:00:00.000Z';
const PH_EDIT_STAMP = '2026-02-01T00:00:00.000Z';
const narrowedProjectHome = (o = {}) => ({
  id: 'cpu-audit-abc123',
  label: 'CPU audit & fixes',
  agentName: 'builder',
  tag: 'build',
  prompt: 'Audit CPU',
  projects: ['/home/u/proj'],
  surface: 'project-home',
  createdAt: PH_STAMP,
  updatedAt: PH_EDIT_STAMP,
  ...o,
});

test('widenProjectHomeScope widens narrowed project-home entries only', () => {
  const ph = narrowedProjectHome();
  const phAll = narrowedProjectHome({ id: 'ph-all-000001', projects: ['*'] });
  const phMixed = narrowedProjectHome({ id: 'ph-mix-000001', projects: ['*', '/x'] });
  const sess = narrowedProjectHome({ id: 'sess-000001', surface: 'sessions' });
  const { macros, changed } = lib.widenProjectHomeScope([ph, phAll, phMixed, sess]);
  expect(changed).toBe(true);
  expect(macros[0]).toEqual({ ...ph, projects: ['*'] });
  expect(macros[0].updatedAt).toBe(PH_EDIT_STAMP);
  expect(macros[0].createdAt).toBe(PH_STAMP);
  expect(macros[1]).toEqual(phAll);
  expect(macros[2]).toEqual({ ...phMixed, projects: ['*'] });
  expect(macros[3]).toBe(sess);
  expect(ph.projects).toEqual(['/home/u/proj']);

  const none = lib.widenProjectHomeScope([phAll, sess]);
  expect(none.changed).toBe(false);
  expect(none.macros).toEqual([phAll, sess]);
});

test('listMacros widens a stored project-home macro and persists once', async () => {
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [narrowedProjectHome()] }));
  const listed = await lib.listMacros(opts);
  expect(listed).toHaveLength(1);
  expect(listed[0].projects).toEqual(['*']);
  expect(listed[0].updatedAt).toBe(PH_EDIT_STAMP);
  const afterFirst = fs.readFileSync(filePath, 'utf8');
  expect(JSON.parse(afterFirst).macros[0].projects).toEqual(['*']);
  const again = await lib.listMacros(opts);
  expect(again[0].projects).toEqual(['*']);
  expect(fs.readFileSync(filePath, 'utf8')).toBe(afterFirst);
});

test('narrowed unedited built-in project-home copy is widened and still upgrades', async () => {
  const stored = narrowedProjectHome({
    id: 'builtin-test-one',
    label: 'Test One',
    agentName: 'test-builder',
    prompt: 'v1 prompt',
    builtin: true,
    builtinVersion: 1,
    updatedAt: PH_STAMP,
  });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [stored] }));
  const listed = await lib.listMacros({ ...opts, builtins: TEST_BUILTINS_V2 });
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    projects: ['*'],
    label: 'Test One v2',
    prompt: 'v2 prompt',
    builtinVersion: 2,
    createdAt: PH_STAMP,
    updatedAt: PH_STAMP,
  });
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')).macros[0];
  expect(onDisk.projects).toEqual(['*']);
  expect(onDisk.updatedAt).toBe(PH_STAMP);
});

test('widening alone keeps an unedited built-in upgradable later', async () => {
  const stored = narrowedProjectHome({
    id: 'builtin-test-one',
    label: 'Test One',
    agentName: 'test-builder',
    prompt: 'v1 prompt',
    builtin: true,
    builtinVersion: 1,
    updatedAt: PH_STAMP,
  });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [stored] }));
  const v1 = await lib.listMacros({ ...opts, builtins: TEST_BUILTINS_V1 });
  expect(v1[0]).toMatchObject({ projects: ['*'], updatedAt: PH_STAMP, builtinVersion: 1 });
  const v2 = await lib.listMacros({ ...opts, builtins: TEST_BUILTINS_V2 });
  expect(v2[0]).toMatchObject({ projects: ['*'], label: 'Test One v2', builtinVersion: 2 });
});

test('saveMacro stores ["*"] for every project-home save', async () => {
  const a = await lib.saveMacro(base({ surface: 'project-home', projects: ['/x'] }), opts);
  expect(a.projects).toEqual(['*']);
  const { projects: _p, ...noProjects } = base({ label: 'No projects', surface: 'project-home' });
  const b = await lib.saveMacro(noProjects, opts);
  expect(b.projects).toEqual(['*']);

  const s = await lib.saveMacro(base({ label: 'Sess' }), opts);
  expect(s.projects).toEqual(['/work/a']);
  const switched = await lib.saveMacro({ ...base({ label: 'Sess' }), id: s.id, surface: 'project-home' }, opts);
  expect(switched.projects).toEqual(['*']);

  const narrowed = await lib.saveMacro({ ...base({ label: 'Sess' }), id: s.id, projects: ['/x'] }, opts);
  expect(narrowed.surface).toBe('project-home');
  expect(narrowed.projects).toEqual(['*']);

  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')).macros;
  for (const m of onDisk) expect(m.projects).toEqual(['*']);
});

test('sessions macro keeps its projects handling', async () => {
  const s = await lib.saveMacro(base({ projects: ['/work/a/', '/work/b'] }), opts);
  expect(s.projects).toEqual(['/work/a', '/work/b']);
  const kept = await lib.saveMacro({ ...base(), id: s.id, projects: undefined }, opts);
  expect(kept.projects).toEqual(['/work/a', '/work/b']);
  const changed = await lib.saveMacro({ ...base(), id: s.id, projects: ['/work/c'] }, opts);
  expect(changed.projects).toEqual(['/work/c']);
  const { projects: _p, ...noProjects } = base({ label: 'Empty' });
  const empty = await lib.saveMacro(noProjects, opts);
  expect(empty.projects).toEqual([]);
});

test('a narrowed stored project-home macro cannot be narrowed or removed', async () => {
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, macros: [narrowedProjectHome()] }));
  const off = await lib.setMacroProject({ id: 'cpu-audit-abc123', cwd: '/home/u/proj', enabled: false }, opts);
  expect(off).toEqual({ ok: false, error: 'macro is shown in every project' });
  const afterSet = fs.readFileSync(filePath, 'utf8');
  const rm = await lib.removeMacroFromProject({ id: 'cpu-audit-abc123', cwd: '/home/u/proj' }, opts);
  expect(rm.ok).toBe(false);
  expect(rm.error).toMatch(/shown in every project/);
  expect(fs.readFileSync(filePath, 'utf8')).toBe(afterSet);
  const onDisk = JSON.parse(afterSet).macros;
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0]).toMatchObject({ projects: ['*'], updatedAt: PH_EDIT_STAMP });
});
