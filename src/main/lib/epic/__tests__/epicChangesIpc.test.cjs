'use strict';

import { test, expect, vi } from 'vitest';
const { registerEpicChangesHandlers } = require('../epicChanges.cjs');

function setup(getEpicChanges) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => { handlers.set(ch, fn); } };
  registerEpicChangesHandlers(ipcMain, { getEpicChanges });
  return handlers;
}

test('registers the epicChanges:get channel', () => {
  const handlers = setup(vi.fn());
  expect([...handlers.keys()]).toEqual(['epicChanges:get']);
});

test('refuses an invalid payload without calling getEpicChanges', async () => {
  const run = vi.fn(async () => ({ ok: true }));
  const h = setup(run).get('epicChanges:get');
  for (const bad of [undefined, {}, { cwd: '', epicId: 'e1' }, { cwd: '/p', epicId: '' },
    { cwd: '/p', epicId: 'x'.repeat(201) }, { cwd: '/p', epicId: 'e1', extra: 1 }, { cwd: 5, epicId: 'e1' }]) {
    expect(() => h({}, bad)).toThrow();
  }
  expect(run).not.toHaveBeenCalled();
});

test('two concurrent identical calls share one getEpicChanges run; settled entry is dropped', async () => {
  let resolve;
  const run = vi.fn(() => new Promise((r) => { resolve = r; }));
  const h = setup(run).get('epicChanges:get');
  const a = h({}, { cwd: '/p', epicId: 'e1' });
  const b = h({}, { cwd: '/p', epicId: 'e1' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith({ cwd: '/p', epicId: 'e1' });
  resolve({ ok: true, sections: [] });
  expect(await a).toEqual({ ok: true, sections: [] });
  expect(await b).toEqual({ ok: true, sections: [] });
  run.mockImplementation(async () => ({ ok: true, again: true }));
  expect(await h({}, { cwd: '/p', epicId: 'e1' })).toEqual({ ok: true, again: true });
  expect(run).toHaveBeenCalledTimes(2);
});

test('different keys run independently', async () => {
  const run = vi.fn(async ({ epicId }) => ({ ok: true, epicId }));
  const h = setup(run).get('epicChanges:get');
  const [a, b] = await Promise.all([h({}, { cwd: '/p', epicId: 'e1' }), h({}, { cwd: '/p', epicId: 'e2' })]);
  expect(a.epicId).toBe('e1');
  expect(b.epicId).toBe('e2');
  expect(run).toHaveBeenCalledTimes(2);
});
