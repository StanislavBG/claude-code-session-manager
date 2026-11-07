'use strict';

import { test, expect } from 'vitest';
const { effectiveSettings } = require('../lib/effectiveSettings.cjs');

const mkFs = (files) => ({
  readFileSync(f) {
    if (!(f in files)) throw new Error('ENOENT');
    return files[f];
  },
});
const j = JSON.stringify;
const base = { home: '/h', cwd: '/p', managedPath: '/m.json' };

test('managed beats local beats project beats user', () => {
  const fs = mkFs({
    '/h/.claude/settings.json': j({ env: { X: 'user', U: 'u', P: 'u' }, model: 'user' }),
    '/p/.claude/settings.json': j({ env: { X: 'project', P: 'project', L: 'project' }, model: 'project' }),
    '/p/.claude/settings.local.json': j({ env: { X: 'local', L: 'local' } }),
    '/m.json': j({ env: { X: 'managed' } }),
  });
  const r = effectiveSettings({ ...base, fs });
  expect(r.merged.env).toEqual({ X: 'managed', U: 'u', P: 'project', L: 'local' });
  expect(r.merged.model).toBe('project');
  expect(r.winnerByKey['env.X']).toBe('managed');
  expect(r.winnerByKey['env.L']).toBe('local');
  expect(r.winnerByKey['env.P']).toBe('project');
  expect(r.winnerByKey['env.U']).toBe('user');
  expect(r.errors.map((e) => e.file)).toEqual(['/h/.claude/settings.local.json']);
});

test('missing and invalid files are skipped and listed in errors', () => {
  const fs = mkFs({ '/h/.claude/settings.json': j({ a: 1 }), '/p/.claude/settings.json': '{nope', '/m.json': '[]' });
  const r = effectiveSettings({ ...base, fs });
  expect(r.merged).toEqual({ a: 1 });
  const bad = r.errors.map((e) => e.file).sort();
  expect(bad).toEqual(['/h/.claude/settings.local.json', '/m.json', '/p/.claude/settings.json', '/p/.claude/settings.local.json']);
});

test('arrays accumulate across scopes low to high', () => {
  const fs = mkFs({
    '/h/.claude/settings.json': j({ availableModels: ['a'] }),
    '/p/.claude/settings.local.json': j({ availableModels: ['b'] }),
  });
  expect(effectiveSettings({ ...base, fs }).merged.availableModels).toEqual(['a', 'b']);
});

test('without cwd only user and managed are read', () => {
  const fs = mkFs({ '/h/.claude/settings.json': j({ k: 1 }), '/m.json': j({ k: 2 }) });
  const r = effectiveSettings({ home: '/h', managedPath: '/m.json', fs });
  expect(r.merged.k).toBe(2);
});
