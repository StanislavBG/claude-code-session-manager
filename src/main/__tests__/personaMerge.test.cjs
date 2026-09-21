/**
 * personaMerge.test.cjs — overlay-over-global persona MERGE (lib/personaMerge.cjs)
 * and every reader that goes through it.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/personaMerge.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveMergedPersona } = require('../lib/personaMerge.cjs');
const { readOverlayAwarePersonaModel, resolvePrdPersonaForSpawn } = require('../lib/agentModelResolve.cjs');
const { resolveEpicEffort } = require('../lib/agentEffortResolve.cjs');
const { resolveEffectiveModelInfo } = require('../lib/effectiveModelInfo.cjs');
const { getPersonaBody, listPersonas } = require('../agentLibrary.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const noop = (p) => p;

function persona(dir, name, fmLines, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), ['---', ...fmLines, '---', body].join('\n'));
}

function setup({ global, overlay }) {
  const cwd = mk('sm-pm-cwd-');
  const globalDir = mk('sm-pm-global-');
  if (global) persona(globalDir, 'dev-lead', global.fm, global.body);
  if (overlay) persona(path.join(cwd, '.claude', 'agents'), 'dev-lead', overlay.fm, overlay.body);
  return { cwd, globalDir, deps: { globalDir, validatePath: noop } };
}

const GLOBAL = { fm: ['name: dev-lead', 'description: d', 'model: sonnet', 'effort: low'], body: 'Global body.' };

test('frontmatter-only overlay overrides model', () => {
  const { cwd, deps } = setup({ global: GLOBAL, overlay: { fm: ['model: claude-opus-4-6'], body: '' } });
  expect(readOverlayAwarePersonaModel('dev-lead', { ...deps, cwd })).toBe('claude-opus-4-6');
  const m = resolveMergedPersona(cwd, 'dev-lead', deps);
  expect(m.provenance.model).toBe('overlay');
  expect(m.provenance.description).toBe('global');
});

test('frontmatter-only overlay overrides effort; source reports persona-overlay', () => {
  const { cwd, deps } = setup({ global: GLOBAL, overlay: { fm: ['effort: high'], body: '' } });
  expect(resolveEpicEffort({ cwd, agentType: 'dev-lead', deps })).toEqual({ effort: 'high', source: 'persona-overlay' });
});

test('a key absent from the overlay falls back to the global (model stays global, effort from overlay)', () => {
  const { cwd, deps } = setup({ global: GLOBAL, overlay: { fm: ['effort: high'], body: '' } });
  expect(readOverlayAwarePersonaModel('dev-lead', { ...deps, cwd })).toBe('sonnet');
  // and the reverse: effort absent from overlay -> global effort, sourced 'persona'
  const s2 = setup({ global: GLOBAL, overlay: { fm: ['model: opus'], body: '' } });
  expect(resolveEpicEffort({ cwd: s2.cwd, agentType: 'dev-lead', deps: s2.deps })).toEqual({ effort: 'low', source: 'persona' });
});

test('an overlay with no body uses the global body', () => {
  const { cwd, deps } = setup({ global: GLOBAL, overlay: { fm: ['model: opus'], body: '\n  \n' } });
  const m = resolveMergedPersona(cwd, 'dev-lead', deps);
  expect(m.body.trim()).toBe('Global body.');
  expect(m.bodySource).toBe('global');
});

test('a full-body overlay replaces the body wholesale and keeps its raw text byte-identical', () => {
  const { cwd, deps } = setup({ global: GLOBAL, overlay: { fm: ['name: dev-lead', 'model: haiku'], body: 'Overlay body.' } });
  const m = resolveMergedPersona(cwd, 'dev-lead', deps);
  expect(m.body.trim()).toBe('Overlay body.');
  expect(m.bodySource).toBe('overlay');
  expect(m.text).toBe(fs.readFileSync(path.join(cwd, '.claude', 'agents', 'dev-lead.md'), 'utf8'));
});

test("this repo's three full-body overlays resolve byte-identically (text + body + path)", async () => {
  const repoAgents = path.resolve(__dirname, '..', '..', '..', '.claude', 'agents');
  const globalDir = mk('sm-pm-global-');
  for (const name of ['bilko-host-publisher', 'builder', 'project-home-builder']) {
    persona(globalDir, name, [`name: ${name}`, 'description: g', 'model: opus'], 'global body');
    const overlayFile = path.join(repoAgents, `${name}.md`);
    const raw = fs.readFileSync(overlayFile, 'utf8');
    const m = resolveMergedPersona(path.resolve(repoAgents, '..', '..'), name, { globalDir, validatePath: noop });
    expect(m.text).toBe(raw);
    expect(m.path).toBe(overlayFile);
    expect(m.body).toBe(require('../lib/prdFrontmatter.cjs').splitFrontmatter(raw).body);
    const viaLib = await getPersonaBody({ cwd: path.resolve(repoAgents, '..', '..'), name, globalDir, validatePath: noop });
    expect(viaLib.text).toBe(raw);
  }
});

test('malformed overlay frontmatter degrades to the global persona, never throws, and is reported', () => {
  const { cwd, globalDir } = setup({ global: GLOBAL });
  fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'dev-lead.md'), '---\nmodel: claude-opus-4-6\nno closing fence');
  const deps = { globalDir, validatePath: noop };
  const m = resolveMergedPersona(cwd, 'dev-lead', deps);
  expect(m.fm.model).toBe('sonnet');
  expect(m.fromOverlay).toBe(false);
  expect(m.overlayIssue).toMatch(/malformed/);
  expect(readOverlayAwarePersonaModel('dev-lead', { ...deps, cwd })).toBe('sonnet');
  const { todayFile } = require('../lib/opsErrorLog.cjs');
  expect(fs.readFileSync(todayFile(cwd), 'utf8')).toMatch(/malformed frontmatter/);
});

test('an overlay with no global counterpart works standalone', () => {
  const { cwd, deps } = setup({ overlay: { fm: ['name: dev-lead', 'model: opus'], body: 'Solo body.' } });
  const m = resolveMergedPersona(cwd, 'dev-lead', deps);
  expect(m.body.trim()).toBe('Solo body.');
  expect(m.globalPath).toBeNull();
  expect(readOverlayAwarePersonaModel('dev-lead', { ...deps, cwd })).toBe('opus');
});

test("overlay `model: inherit` defers to the settings default — it does NOT fall back to the global model", async () => {
  const { cwd, deps } = setup({ global: GLOBAL, overlay: { fm: ['model: inherit'], body: '' } });
  expect(readOverlayAwarePersonaModel('dev-lead', { ...deps, cwd })).toBe('inherit');
  const r = await resolvePrdPersonaForSpawn({ cwd, agentType: 'dev-lead', fallbackModel: 'sonnet-fallback', deps: { getPersonaBody: (a) => getPersonaBody({ ...a, ...deps }) } });
  expect(r.model).toBe('sonnet-fallback');
});

test('resolvePrdPersonaForSpawn hands the executor the merged model AND the global body for a frontmatter-only overlay', async () => {
  const { cwd, deps } = setup({ global: GLOBAL, overlay: { fm: ['model: claude-opus-4-6'], body: '' } });
  const r = await resolvePrdPersonaForSpawn({ cwd, agentType: 'dev-lead', deps: { getPersonaBody: (a) => getPersonaBody({ ...a, ...deps }) } });
  expect(r.model).toBe('claude-opus-4-6');
  expect(r.systemPrompt).toBe('Global body.');
});

test('a crafted agentType is rejected by every reader (PERSONA_NAME_RE traversal guard)', async () => {
  const { cwd, deps } = setup({ global: GLOBAL });
  const evil = '../../other-project/CLAUDE';
  expect(resolveMergedPersona(cwd, evil, deps)).toBeNull();
  expect(readOverlayAwarePersonaModel(evil, { ...deps, cwd })).toBeNull();
  expect(await getPersonaBody({ cwd, name: evil, ...deps })).toBeNull();
});

test('getPersonaBody / effectiveModelInfo / listPersonas report per-field provenance, not a whole-file boolean', async () => {
  const { cwd, globalDir, deps } = setup({ global: GLOBAL, overlay: { fm: ['model: claude-opus-4-6'], body: '' } });
  const body = await getPersonaBody({ cwd, name: 'dev-lead', ...deps });
  expect(body.provenance.model).toBe('overlay');
  expect(body.provenance.effort).toBe('global');

  const info = await resolveEffectiveModelInfo({
    cwd,
    agentType: 'dev-lead',
    deps: {
      ...deps,
      activeSessions: { projectRootOf: (p) => p },
      getPersonaBody: (a) => getPersonaBody({ ...a, ...deps }),
    },
  });
  expect(info.modelAlias).toBe('claude-opus-4-6');
  expect(info.modelSource).toBe('persona-overlay');
  expect(info.personaProvenance.effort).toBe('global');
  expect(info.personaEffortSource).toBe('persona');

  const list = await listPersonas({ globalDir, validatePath: noop, loadSessions: async () => ({ tabs: [{ cwd }] }) });
  const dev = list.find((p) => p.name === 'dev-lead');
  expect(dev.overridingProjects).toEqual([path.basename(cwd)]);
  expect(dev.overrideDetails[0]).toMatchObject({ fields: ['model'], bodyOverridden: false, issue: null });
});
