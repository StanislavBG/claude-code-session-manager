/**
 * agentOverlayWrite.test.cjs — Agent Library's per-project OVERRIDE write path
 * (savePersona with `projectName`): frontmatter-only overlay, removal on clear,
 * full-body refusal, and end-to-end resolution for a scheduled PRD.
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
const { resolvePrdPersonaForSpawn } = require('../lib/agentModelResolve.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function setup() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ov-cwd-'));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ov-global-'));
  tmpDirs.push(cwd, globalDir);
  const globalFile = path.join(globalDir, 'dev-lead.md');
  fs.writeFileSync(globalFile, '---\nname: dev-lead\ndescription: d\nmodel: sonnet\n---\nGlobal body.\n');
  const overlayFile = path.join(cwd, '.claude', 'agents', 'dev-lead.md');
  const deps = { globalDir, loadSessions: async () => ({ tabs: [{ cwd }] }), validatePath: (p) => p,
    writeTextAtomic: async (p, t) => { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, t); } };
  const projectName = path.basename(cwd);
  const save = (over) => savePersona({ name: 'dev-lead', projectName, description: '', tools: [], color: '', tags: [], body: '', ...over, ...deps });
  return { cwd, globalFile, overlayFile, deps, save, projectName };
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

test('unknown project is rejected', async () => {
  const { save } = setup();
  await expect(save({ projectName: 'nope', model: 'opus' })).rejects.toThrow(/project not open/);
});

test('listPersonas counts a frontmatter-only overlay and reports global → project values', async () => {
  const { save, deps, projectName } = setup();
  await save({ model: 'claude-opus-4-6' });
  const [p] = await listPersonas(deps);
  expect(p.model).toBe('sonnet');
  expect(p.overridingProjects).toEqual([projectName]);
  expect(p.overrideDetails[0]).toMatchObject({ fields: ['model'], values: { model: 'claude-opus-4-6' }, bodyOverridden: false });
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
