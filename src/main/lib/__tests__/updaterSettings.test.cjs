/**
 * updaterSettings.test.cjs — persistence of the in-app auto-update toggle.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/updaterSettings.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../config.cjs');
const settings = require('../updaterSettings.cjs');

let home;
let realHome;

beforeEach(async () => {
  realHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-updater-settings-home-'));
  // config.cjs write-allows <root>/.claude only for roots that are not os.homedir();
  // spy HOME as a symlink so the real dir registers as a project-style root.
  home = `${realHome}-link`;
  await fsp.symlink(realHome, home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  config.addAllowedRoot(realHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(home, { force: true });
  await fsp.rm(realHome, { recursive: true, force: true });
});

test('storePath lives under ~/.claude/session-manager', () => {
  expect(settings.storePath()).toBe(path.join(home, '.claude', 'session-manager', 'updater.json'));
});

test('load returns the default when the file is missing', async () => {
  expect(await settings.load()).toEqual({ enabled: true, schemaVersion: 1 });
});

test('save(false) then load() round-trips', async () => {
  const saved = await settings.save({ enabled: false });
  expect(saved).toEqual({ enabled: false, schemaVersion: 1 });
  expect(await settings.load()).toEqual({ enabled: false, schemaVersion: 1 });
});

test('corrupt or invalid file loads as the default', async () => {
  const p = settings.storePath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, '{not json');
  expect(await settings.load()).toEqual({ enabled: true, schemaVersion: 1 });
  await fsp.writeFile(p, JSON.stringify({ enabled: false, extra: 1 }));
  expect(await settings.load()).toEqual({ enabled: true, schemaVersion: 1 });
});

test('save rejects unknown keys and non-boolean enabled', async () => {
  await expect(settings.save({ enabled: true, extra: 1 })).rejects.toThrow(Error);
  await expect(settings.save({ enabled: 'no' })).rejects.toThrow(Error);
  await expect(settings.save({})).rejects.toThrow(Error);
});
