'use strict';
import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listPacks, getPack, bundledPacksDir, PACK_LAWS_CHAR_CAP } = require('../packCatalog.cjs');

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

function expectRejected(dir) {
  const r = listPacks({ packsDir: root });
  expect(r.packs.find((p) => p.dir === path.join(root, dir))).toBeUndefined();
  const e = r.errors.find((x) => x.dir === path.join(root, dir));
  expect(e).toBeTruthy();
  expect(typeof e.error).toBe('string');
  expect(e.error.length).toBeGreaterThan(0);
  return r;
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
  expectRejected('no-manifest');
  expectRejected('bad-json');
});

test('rejects a non-kebab-case id', () => {
  writePack('Bad_Id', { manifest: { id: 'Bad_Id', label: 'x', description: 'x' } });
  expectRejected('Bad_Id');
});

test('rejects an id over 40 chars', () => {
  const id = 'a'.repeat(41);
  writePack(id, { manifest: { id, label: 'x', description: 'x' } });
  expectRejected(id);
});

test('rejects an id that differs from its directory name', () => {
  writePack('dir-name', { manifest: { id: 'other-name', label: 'x', description: 'x' } });
  expectRejected('dir-name');
});

test('rejects a label over 60 chars and a description over 300 chars', () => {
  writePack('long-label', { manifest: { id: 'long-label', label: 'l'.repeat(61), description: 'x' } });
  writePack('long-desc', { manifest: { id: 'long-desc', label: 'x', description: 'd'.repeat(301) } });
  expectRejected('long-label');
  expectRejected('long-desc');
});

test('rejects an unknown requires.platform', () => {
  writePack('bad-plat', { manifest: { id: 'bad-plat', label: 'x', description: 'x', requires: { platform: 'aix' } } });
  expectRejected('bad-plat');
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
  expectRejected('no-plugin');
  expectRejected('bad-plugin');
});

test('rejects a plugin.json without a name', () => {
  writePack('no-name', { plugin: { version: '1.0.0' } });
  expectRejected('no-name');
});

test("rejects a plugin name starting with 'claude'", () => {
  writePack('reserved', { plugin: { name: 'claude-ios' } });
  expectRejected('reserved');
});

test('rejects a plugin.json with defaultEnabled false', () => {
  writePack('disabled', { plugin: { name: 'sm-pack-disabled', defaultEnabled: false } });
  expectRejected('disabled');
});

test('laws at the cap are accepted; over the cap are rejected', () => {
  writePack('at-cap', { laws: 'x'.repeat(PACK_LAWS_CHAR_CAP) });
  writePack('over-cap', { laws: 'x'.repeat(PACK_LAWS_CHAR_CAP + 1) });
  const r = expectRejected('over-cap');
  expect(r.packs.map((p) => p.id)).toEqual(['at-cap']);
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
