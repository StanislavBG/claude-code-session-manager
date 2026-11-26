'use strict';
import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listPacks, listUnpackedSkills, getPack, bundledPacksDir, PACK_LAWS_CHAR_CAP } = require('../packCatalog.cjs');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'packcat-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** Write a pack; pass null for a part to omit that file, a string for raw content. */
function writePack(dir, { manifest, plugin, laws } = {}) {
  const d = path.join(root, dir);
  fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
  const m = manifest === undefined ? { id: dir, label: `Label ${dir}`, description: `Desc ${dir}` } : manifest;
  if (m !== null) fs.writeFileSync(path.join(d, 'sm-pack.json'), typeof m === 'string' ? m : JSON.stringify(m));
  const p = plugin === undefined ? { name: `sm-pack-${dir}` } : plugin;
  if (p !== null) fs.writeFileSync(path.join(d, '.claude-plugin', 'plugin.json'), typeof p === 'string' ? p : JSON.stringify(p));
  if (laws !== undefined && laws !== null) fs.writeFileSync(path.join(d, 'laws.md'), laws);
  return d;
}

/**
 * Return the rejection error string for the pack in `dir`, or '' when the pack
 * was listed or produced no error. Callers assert on the returned value.
 */
function rejectionFor(dir) {
  const r = listPacks({ packsDir: root });
  if (r.packs.some((p) => p.dir === path.join(root, dir))) return '';
  const e = r.errors.find((x) => x.dir === path.join(root, dir));
  return e && typeof e.error === 'string' ? e.error : '';
}

test('exports constants and bundledPacksDir points at <package root>/plugins/packs', () => {
  expect(PACK_LAWS_CHAR_CAP).toBe(2000);
  expect(bundledPacksDir()).toBe(path.resolve(__dirname, '..', '..', '..', '..', '..', 'plugins', 'packs'));
  expect(fs.existsSync(path.join(path.dirname(path.dirname(bundledPacksDir())), 'package.json'))).toBe(true);
});

test('a valid pack is listed with every field', () => {
  const d = writePack('ios-swiftui', {
    manifest: { id: 'ios-swiftui', label: 'iOS SwiftUI', description: 'SwiftUI best practices', requires: { platform: 'darwin' } },
    laws: '\n  - Use @Observable.\n\n',
  });
  const r = listPacks({ packsDir: root });
  expect(r.errors).toEqual([]);
  expect(r.packs).toEqual([{
    id: 'ios-swiftui',
    label: 'iOS SwiftUI',
    description: 'SwiftUI best practices',
    dir: d,
    pluginName: 'sm-pack-ios-swiftui',
    laws: '- Use @Observable.',
    requires: { platform: 'darwin' },
    source: 'shipped',
    skills: [],
  }]);
  expect(path.isAbsolute(r.packs[0].dir)).toBe(true);
});

test('laws is empty when laws.md is absent; requires defaults to {}', () => {
  writePack('plain');
  const r = listPacks({ packsDir: root });
  expect(r.errors).toEqual([]);
  expect(r.packs[0].laws).toBe('');
  expect(r.packs[0].requires).toEqual({});
});

test('getPack finds by id and returns null when absent', () => {
  writePack('alpha');
  expect(getPack('alpha', { packsDir: root }).id).toBe('alpha');
  expect(getPack('nope', { packsDir: root })).toBeNull();
  expect(getPack('alpha', { packsDir: path.join(root, 'missing') })).toBeNull();
});

test('rejects a missing or unparsable sm-pack.json', () => {
  writePack('no-manifest', { manifest: null });
  writePack('bad-json', { manifest: '{not json' });
  expect(rejectionFor('no-manifest')).toBe('sm-pack.json missing');
  expect(rejectionFor('bad-json')).toMatch(/^sm-pack\.json is not valid JSON/);
});

test('rejects a non-kebab-case id', () => {
  writePack('Bad_Id', { manifest: { id: 'Bad_Id', label: 'x', description: 'x' } });
  expect(rejectionFor('Bad_Id')).toContain('id: id must be kebab-case');
});

test('rejects an id over 40 chars', () => {
  const id = 'a'.repeat(41);
  writePack(id, { manifest: { id, label: 'x', description: 'x' } });
  expect(rejectionFor(id)).toMatch(/^sm-pack\.json invalid: id: .*40/);
});

test('rejects an id that differs from its directory name', () => {
  writePack('dir-name', { manifest: { id: 'other-name', label: 'x', description: 'x' } });
  expect(rejectionFor('dir-name')).toBe('sm-pack.json id "other-name" must equal its directory name "dir-name"');
});

test('rejects a label over 60 chars and a description over 300 chars', () => {
  writePack('long-label', { manifest: { id: 'long-label', label: 'l'.repeat(61), description: 'x' } });
  writePack('long-desc', { manifest: { id: 'long-desc', label: 'x', description: 'd'.repeat(301) } });
  expect(rejectionFor('long-label')).toMatch(/^sm-pack\.json invalid: label: .*60/);
  expect(rejectionFor('long-desc')).toMatch(/^sm-pack\.json invalid: description: .*300/);
});

test('rejects an unknown requires.platform', () => {
  writePack('bad-plat', { manifest: { id: 'bad-plat', label: 'x', description: 'x', requires: { platform: 'aix' } } });
  expect(rejectionFor('bad-plat')).toMatch(/^sm-pack\.json invalid: requires\.platform: /);
});

test('accepts each allowed platform', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    writePack(`p-${platform}`, { manifest: { id: `p-${platform}`, label: 'x', description: 'x', requires: { platform } } });
  }
  const r = listPacks({ packsDir: root });
  expect(r.errors).toEqual([]);
  expect(r.packs.map((p) => p.requires.platform)).toEqual(['darwin', 'linux', 'win32']);
});

test('rejects a missing or unparsable plugin.json', () => {
  writePack('no-plugin', { plugin: null });
  writePack('bad-plugin', { plugin: '{oops' });
  expect(rejectionFor('no-plugin')).toBe('.claude-plugin/plugin.json missing');
  expect(rejectionFor('bad-plugin')).toMatch(/^\.claude-plugin\/plugin\.json is not valid JSON/);
});

test('rejects a plugin.json without a name', () => {
  writePack('no-name', { plugin: { version: '1.0.0' } });
  expect(rejectionFor('no-name')).toBe('.claude-plugin/plugin.json has no name');
});

test("rejects a plugin name starting with 'claude'", () => {
  writePack('reserved', { plugin: { name: 'claude-ios' } });
  expect(rejectionFor('reserved')).toBe('plugin name "claude-ios" must not start with "claude"');
});

test('rejects a plugin.json with defaultEnabled false', () => {
  writePack('disabled', { plugin: { name: 'sm-pack-disabled', defaultEnabled: false } });
  expect(rejectionFor('disabled')).toMatch(/^plugin\.json sets defaultEnabled:false/);
});

test('laws at the cap are accepted; over the cap are rejected', () => {
  writePack('at-cap', { laws: 'x'.repeat(PACK_LAWS_CHAR_CAP) });
  writePack('over-cap', { laws: 'x'.repeat(PACK_LAWS_CHAR_CAP + 1) });
  expect(rejectionFor('over-cap')).toBe(`laws.md is ${PACK_LAWS_CHAR_CAP + 1} chars, over the ${PACK_LAWS_CHAR_CAP} cap`);
  expect(listPacks({ packsDir: root }).packs.map((p) => p.id)).toEqual(['at-cap']);
});

test('one bad pack never hides the others', () => {
  writePack('good-one');
  writePack('broken', { manifest: '{' });
  writePack('good-two');
  const r = listPacks({ packsDir: root });
  expect(r.packs.map((p) => p.id)).toEqual(['good-one', 'good-two']);
  expect(r.errors).toHaveLength(1);
});

test('a missing packs directory returns empty lists', () => {
  expect(listPacks({ packsDir: path.join(root, 'does-not-exist') })).toEqual({ packs: [], errors: [] });
});

test('packs are sorted by id and plain files are ignored', () => {
  writePack('zeta');
  writePack('alpha');
  writePack('mid');
  fs.writeFileSync(path.join(root, 'README.md'), 'not a pack');
  const r = listPacks({ packsDir: root });
  expect(r.errors).toEqual([]);
  expect(r.packs.map((p) => p.id)).toEqual(['alpha', 'mid', 'zeta']);
});

test('listPacks never throws, even when packsDir is a file', () => {
  const f = path.join(root, 'file');
  fs.writeFileSync(f, 'x');
  expect(() => listPacks({ packsDir: f })).not.toThrow();
  expect(listPacks({ packsDir: f }).packs).toEqual([]);
});

function writePlugin(home, name, { skills = [], desc, install = true } = {}) {
  const d = path.join(home, 'cache', name);
  fs.mkdirSync(path.join(d, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, description: desc }));
  for (const s of skills) {
    fs.mkdirSync(path.join(d, 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(d, 'skills', s, 'SKILL.md'), '# s');
  }
  fs.mkdirSync(path.join(d, 'skills', 'no-skill-md'), { recursive: true });
  return d;
}
function writeInstalled(home, body) {
  fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

test('an installed plugin is listed with its skills', () => {
  const home = path.join(root, 'home');
  const d = writePlugin(home, 'dev-kit', { skills: ['develop', 'builder'], desc: 'Dev things' });
  writeInstalled(home, { version: 2, plugins: { 'dev-kit@mk': [{ installPath: d }] } });
  writePack('shipped-one');
  const r = listPacks({ packsDir: root, home });
  const p = r.packs.find((x) => x.id === 'dev-kit');
  expect(p).toMatchObject({ id: 'dev-kit', label: 'dev-kit', description: 'Dev things', dir: d, source: 'plugin', laws: '', requires: {}, skills: ['dev-kit:builder', 'dev-kit:develop'] });
  expect(r.packs.find((x) => x.id === 'shipped-one').source).toBe('shipped');
});

test('malformed or missing installed_plugins.json never throws', () => {
  const home = path.join(root, 'home');
  expect(listPacks({ packsDir: path.join(root, 'none'), home })).toEqual({ packs: [], errors: [] });
  writeInstalled(home, '{nope');
  const r = listPacks({ packsDir: path.join(root, 'none'), home });
  expect(r.packs).toEqual([]);
  expect(r.errors[0].error).toMatch(/not valid JSON/);
  writeInstalled(home, { plugins: [] });
  expect(listPacks({ packsDir: path.join(root, 'none'), home }).errors).toHaveLength(1);
});

test('a plugin with a missing installPath yields an error entry', () => {
  const home = path.join(root, 'home');
  writeInstalled(home, { plugins: { 'a@m': [{}], 'b@m': [{ installPath: path.join(home, 'gone') }] } });
  const r = listPacks({ packsDir: path.join(root, 'none'), home });
  expect(r.packs).toEqual([]);
  expect(r.errors).toHaveLength(2);
});

test('a shipped/plugin id collision keeps the shipped pack and errors the plugin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'packhome-'));
  const d = writePlugin(home, 'alpha');
  writeInstalled(home, { plugins: { 'alpha@m': [{ installPath: d }] } });
  writePack('alpha');
  const r = listPacks({ packsDir: root, home });
  expect(r.packs.map((p) => p.source)).toEqual(['shipped']);
  expect(r.errors).toEqual([{ dir: d, error: expect.stringContaining('collides') }]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('listUnpackedSkills lists ~/.claude/skills folders with a SKILL.md', () => {
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), '#');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'empty'), { recursive: true });
  expect(listUnpackedSkills({ home })).toEqual(['mine']);
  expect(listUnpackedSkills({ home: path.join(root, 'nohome') })).toEqual([]);
});
