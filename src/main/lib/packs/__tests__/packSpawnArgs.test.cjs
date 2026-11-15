'use strict';
import { test, expect } from 'vitest';
const { composePackSpawnArgs } = require('../packSpawnArgs.cjs');

const catalog = [
  { id: 'ios', label: 'iOS', description: 'd', dir: '/abs/packs/ios', pluginName: 'sm-pack-ios', laws: 'Use SwiftUI.', requires: { platform: 'darwin' } },
  { id: 'web', label: 'Web', description: 'd', dir: '/abs/packs/web', pluginName: 'sm-pack-web', laws: 'Prefer semantic HTML.', requires: {} },
  { id: 'quiet', label: 'Quiet', description: 'd', dir: '/abs/packs/quiet', pluginName: 'sm-pack-quiet', laws: '', requires: {} },
];

test('exports composePackSpawnArgs returning { pluginDirArgs, laws, unknown }', () => {
  const r = composePackSpawnArgs({ packIds: ['web'], catalog, platform: 'linux' });
  expect(Object.keys(r).sort()).toEqual(['laws', 'pluginDirArgs', 'unknown']);
});

test('one --plugin-dir per known id, in given order, deduplicated', () => {
  const r = composePackSpawnArgs({ packIds: ['quiet', 'web', 'quiet', 'ios', 'web'], catalog, platform: 'darwin' });
  expect(r.pluginDirArgs).toEqual([
    '--plugin-dir', '/abs/packs/quiet',
    '--plugin-dir', '/abs/packs/web',
    '--plugin-dir', '/abs/packs/ios',
  ]);
  expect(r.unknown).toEqual([]);
});

test('absent, empty, or non-array packIds → [], "", []', () => {
  for (const packIds of [undefined, null, [], 'web', 42, { 0: 'web' }]) {
    expect(composePackSpawnArgs({ packIds, catalog, platform: 'linux' })).toEqual({ pluginDirArgs: [], laws: '', unknown: [] });
  }
  expect(composePackSpawnArgs()).toEqual({ pluginDirArgs: [], laws: '', unknown: [] });
});

test('laws is "" when no selected pack has laws', () => {
  expect(composePackSpawnArgs({ packIds: ['quiet'], catalog, platform: 'linux' }).laws).toBe('');
});

test('laws: header then "## <label> pack" + laws per pack with laws, blank-line separated', () => {
  const r = composePackSpawnArgs({ packIds: ['web', 'quiet', 'ios'], catalog, platform: 'darwin' });
  expect(r.laws).toBe([
    '# Context packs for this session',
    '## Web pack',
    'Prefer semantic HTML.',
    '## iOS pack',
    'Use SwiftUI.',
  ].join('\n\n'));
});

test('unknown ids are reported and skipped; path-like ids never become dirs', () => {
  const r = composePackSpawnArgs({ packIds: ['../x', 'web', 'nope', '../x', '/etc'], catalog, platform: 'linux' });
  expect(r.pluginDirArgs).toEqual(['--plugin-dir', '/abs/packs/web']);
  expect(r.unknown).toEqual(['../x', 'nope', '/etc']);
  expect(r.pluginDirArgs.some((a) => a.includes('..') || a === '/etc')).toBe(false);
});

test('pack whose requires.platform differs is skipped and reported unknown', () => {
  const r = composePackSpawnArgs({ packIds: ['ios', 'web'], catalog, platform: 'linux' });
  expect(r.pluginDirArgs).toEqual(['--plugin-dir', '/abs/packs/web']);
  expect(r.unknown).toEqual(['ios']);
  expect(r.laws).not.toContain('iOS');
});

test('never throws on a malformed catalog', () => {
  const r = composePackSpawnArgs({ packIds: ['web'], catalog: [null, 5, { id: 'web' }], platform: 'linux' });
  expect(r).toEqual({ pluginDirArgs: [], laws: '', unknown: ['web'] });
  expect(() => composePackSpawnArgs({ packIds: ['web'], catalog: 'bad', platform: 'linux' })).not.toThrow();
});

test('catalog defaults to the shipped catalog; platform defaults to process.platform', () => {
  const r = composePackSpawnArgs({ packIds: ['definitely-not-a-pack'] });
  expect(r.unknown).toEqual(['definitely-not-a-pack']);
  expect(r.pluginDirArgs).toEqual([]);
});

test('platform defaults to process.platform for requires.platform checks', () => {
  const other = process.platform === 'darwin' ? 'linux' : 'darwin';
  const cat = [
    { id: 'here', label: 'Here', dir: '/abs/here', laws: '', requires: { platform: process.platform } },
    { id: 'there', label: 'There', dir: '/abs/there', laws: '', requires: { platform: other } },
  ];
  const r = composePackSpawnArgs({ packIds: ['here', 'there'], catalog: cat });
  expect(r.pluginDirArgs).toEqual(['--plugin-dir', '/abs/here']);
  expect(r.unknown).toEqual(['there']);
});
