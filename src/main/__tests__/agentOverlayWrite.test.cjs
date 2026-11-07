/**
 * agentOverlayWrite.test.cjs — Agent Library's per-project OVERRIDE write path
 * (savePersona with `projectCwd`, an OPEN project's absolute cwd):
 * frontmatter-only overlay, removal on clear, full-body refusal, resolution by
 * cwd (never by folder name — two open projects can share one), fail-closed on
 * an unknown/empty cwd, and end-to-end resolution for a scheduled PRD.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/agentOverlayWrite.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { savePersona, listPersonas, getPersonaBody } = require('../agentLibrary.cjs');
const { resolvePrdPersonaForSpawn } = require('../lib/claude/agentModelResolve.cjs');
const configMgr = require('../config.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

const writeTextAtomic = async (p, t) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, t); };
const overlayOf = (cwd) => path.join(cwd, '.claude', 'agents', 'dev-lead.md');

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// Under the per-run sandbox HOME (vitest globalSetup), so the REAL validatePath accepts it.
function mkHomeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.homedir(), prefix));
  tmpDirs.push(d);
  return d;
}

function globalFixture() {
  const globalDir = mkTmp('sm-ov-global-');
  const globalFile = path.join(globalDir, 'dev-lead.md');
  fs.writeFileSync(globalFile, '---\nname: dev-lead\ndescription: d\nmodel: sonnet\n---\nGlobal body.\n');
  return { globalDir, globalFile };
}

// `cwds` are the open tabs; `save(projectCwd, over)` is the Agent Library's override call shape
// (dummy description/tools/body — exactly what would blank the global file on a fallthrough).
function fixture(cwds) {
  const { globalDir, globalFile } = globalFixture();
  const deps = { globalDir, loadSessions: async () => ({ tabs: cwds.map((cwd) => ({ cwd })) }), validatePath: (p) => p, writeTextAtomic };
  const save = (projectCwd, over) => savePersona({ name: 'dev-lead', projectCwd, description: '', tools: [], color: '', tags: [], body: '', ...over, ...deps });
  return { globalFile, deps, save };
}

function setup() {
  const cwd = mkTmp('sm-ov-cwd-');
  const { globalFile, deps, save } = fixture([cwd]);
  return { cwd, globalFile, overlayFile: overlayOf(cwd), deps, save: (over) => save(cwd, over) };
}

test('setting a model writes a frontmatter-only overlay with only that key; global untouched', async () => {
  const { overlayFile, globalFile, save } = setup();
  const before = fs.readFileSync(globalFile, 'utf8');
  await save({ model: 'claude-opus-4-6', effort: 'inherit' });
  expect(fs.readFileSync(overlayFile, 'utf8')).toBe('---\nmodel: claude-opus-4-6\n---\n');
  expect(fs.readFileSync(globalFile, 'utf8')).toBe(before);
});

test('adding effort adds only that key', async () => {
  const { overlayFile, save } = setup();
  await save({ model: 'claude-opus-4-6' });
  await save({ model: 'claude-opus-4-6', effort: 'high' });
  expect(fs.readFileSync(overlayFile, 'utf8')).toBe('---\nmodel: claude-opus-4-6\neffort: high\n---\n');
});

test('clearing both removes the overlay file', async () => {
  const { overlayFile, save } = setup();
  await save({ model: 'claude-opus-4-6', effort: 'high' });
  const r = await save({ model: 'inherit', effort: 'inherit' });
  expect(r.removed).toBe(true);
  expect(fs.existsSync(overlayFile)).toBe(false);
});

test('a full-body overlay is refused, not rewritten', async () => {
  const { overlayFile, save } = setup();
  fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
  const full = '---\nname: dev-lead\nmodel: haiku\n---\nProject body.\n';
  fs.writeFileSync(overlayFile, full);
  await expect(save({ model: 'opus' })).rejects.toThrow(/full-body/);
  expect(fs.readFileSync(overlayFile, 'utf8')).toBe(full);
});

test('an unknown or empty projectCwd throws "project not open" and writes nothing — never a global fallthrough', async () => {
  const { overlayFile, globalFile, save } = setup();
  const before = fs.readFileSync(globalFile, 'utf8');
  await expect(save({ projectCwd: '/nope/not-open', model: 'opus' })).rejects.toThrow('project not open: /nope/not-open');
  await expect(save({ projectCwd: '', model: 'opus' })).rejects.toThrow(/project not open/);
  await expect(save({ projectCwd: null, model: 'opus' })).rejects.toThrow(/project not open/);
  expect(fs.readFileSync(globalFile, 'utf8')).toBe(before);
  expect(fs.existsSync(overlayFile)).toBe(false);
});

// No validatePath/writeTextAtomic stubs below: these go through config.cjs's real write boundary,
// which only allows `<root>/.claude/` under a root registered via addAllowedRoot — and a dormant tab
// (no terminal ever spawned, e.g. every tab restored after a restart) has none.
test('a dormant open project (root never registered) is overridden through the real config writer', async () => {
  const cwd = mkHomeTmp('sm-ov-dormant-');
  expect(configMgr.getAllowedRoots()).not.toContain(fs.realpathSync(cwd));
  const { globalDir, globalFile } = globalFixture();
  const before = fs.readFileSync(globalFile);
  await savePersona({
    name: 'dev-lead', projectCwd: cwd, description: '', tools: [], color: '', tags: [], body: '', model: 'opus',
    globalDir, loadSessions: async () => ({ tabs: [{ cwd }] }),
  });
  expect(fs.readFileSync(overlayOf(cwd), 'utf8')).toBe('---\nmodel: opus\n---\n');
  expect(fs.readFileSync(globalFile)).toEqual(before);
});

test('a not-open or empty cwd under HOME is refused with "project not open" before any root is registered', async () => {
  const openCwd = mkHomeTmp('sm-ov-open-');
  const notOpen = mkHomeTmp('sm-ov-not-open-');
  const { globalDir, globalFile } = globalFixture();
  const before = fs.readFileSync(globalFile);
  const rootsBefore = configMgr.getAllowedRoots();
  const save = (projectCwd) => savePersona({
    name: 'dev-lead', projectCwd, description: '', tools: [], color: '', tags: [], body: '', model: 'opus',
    globalDir, loadSessions: async () => ({ tabs: [{ cwd: openCwd }] }),
  });
  await expect(save(notOpen)).rejects.toThrow(`project not open: ${notOpen}`);
  await expect(save('')).rejects.toThrow(/project not open/);
  expect(configMgr.getAllowedRoots()).not.toContain(notOpen);
  expect(configMgr.getAllowedRoots()).not.toContain(fs.realpathSync(notOpen));
  expect(configMgr.getAllowedRoots()).toEqual(rootsBefore);
  expect(fs.existsSync(overlayOf(notOpen))).toBe(false);
  expect(fs.readFileSync(globalFile)).toEqual(before);
});

test('a projectCwd with a trailing or doubled slash resolves to the same open project', async () => {
  const { cwd, overlayFile, save } = setup();
  await save({ projectCwd: `${cwd}/`, model: 'opus' });
  expect(fs.readFileSync(overlayFile, 'utf8')).toBe('---\nmodel: opus\n---\n');
  await save({ projectCwd: cwd.replace(/\//g, '//'), model: 'opus', effort: 'high' });
  expect(fs.readFileSync(overlayFile, 'utf8')).toBe('---\nmodel: opus\neffort: high\n---\n');
});

test('two open projects with the same folder name: saving for the second cwd writes only the second overlay, and listPersonas reports two details with distinct cwd', async () => {
  const first = path.join(mkTmp('sm-ov-a-'), 'proj');
  const second = path.join(mkTmp('sm-ov-b-'), 'proj');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const { globalFile, deps, save } = fixture([first, second]);
  const before = fs.readFileSync(globalFile, 'utf8');

  await save(second, { model: 'claude-opus-4-6' });
  expect(fs.existsSync(overlayOf(first))).toBe(false);
  expect(fs.readFileSync(overlayOf(second), 'utf8')).toBe('---\nmodel: claude-opus-4-6\n---\n');
  expect(fs.readFileSync(globalFile, 'utf8')).toBe(before);

  await save(first, { model: 'haiku' });
  expect(fs.readFileSync(overlayOf(second), 'utf8')).toBe('---\nmodel: claude-opus-4-6\n---\n');
  const [p] = await listPersonas(deps);
  expect(p.overridingProjects).toEqual(['proj', 'proj']);
  expect(p.overrideDetails).toHaveLength(2);
  expect(p.overrideDetails[0]).toMatchObject({ project: 'proj', cwd: first, values: { model: 'haiku' } });
  expect(p.overrideDetails[1]).toMatchObject({ project: 'proj', cwd: second, values: { model: 'claude-opus-4-6' } });
});

test('listPersonas counts a frontmatter-only overlay and reports global → project values', async () => {
  const { cwd, save, deps } = setup();
  await save({ model: 'claude-opus-4-6' });
  const [p] = await listPersonas(deps);
  expect(p.model).toBe('sonnet');
  expect(p.overridingProjects).toEqual([path.basename(cwd)]);
  expect(p.overrideDetails[0]).toMatchObject({ project: path.basename(cwd), cwd, fields: ['model'], values: { model: 'claude-opus-4-6' }, bodyOverridden: false });
});

test('scheduled-PRD model resolution returns the overlay model; global persona stays sonnet', async () => {
  const { cwd, save, deps } = setup();
  await save({ model: 'claude-opus-4-6' });
  const r = await resolvePrdPersonaForSpawn({
    cwd, agentType: 'dev-lead', fallbackModel: 'fallback',
    deps: { getPersonaBody: (a) => getPersonaBody({ ...a, ...deps }) },
  });
  expect(r.model).toBe('claude-opus-4-6');
  expect(r.systemPrompt).toContain('Global body.');
  const [g] = await listPersonas(deps);
  expect(g.model).toBe('sonnet');
});
