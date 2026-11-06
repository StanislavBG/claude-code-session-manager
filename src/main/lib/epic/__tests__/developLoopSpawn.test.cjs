'use strict';
import { test, expect } from 'vitest';
const { developLoopOffSettingsArgs } = require('../developLoopSpawn.cjs');
const { ENABLED_KEY } = require('../../../seedDevPlugin.cjs');

test('developLoop false yields --settings disabling the plugin', () => {
  const a = developLoopOffSettingsArgs({ developLoop: false });
  expect(a).toHaveLength(2);
  expect(a[0]).toBe('--settings');
  expect(JSON.parse(a[1])).toEqual({ enabledPlugins: { [ENABLED_KEY]: false } });
});

test('absent, true and null epic yield no args', () => {
  expect(developLoopOffSettingsArgs({})).toEqual([]);
  expect(developLoopOffSettingsArgs({ developLoop: true })).toEqual([]);
  expect(developLoopOffSettingsArgs(null)).toEqual([]);
  expect(developLoopOffSettingsArgs(undefined)).toEqual([]);
});
