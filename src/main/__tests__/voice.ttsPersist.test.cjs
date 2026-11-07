/**
 * voice.ttsPersist.test.cjs — ttsEnabled persists in voice.json via
 * voiceSettings.cjs, and every voice:* ipcMain.handle lives in voiceHotkey.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/voice.ttsPersist.test.cjs
 */
'use strict';

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const handled = new Map();
const electronStub = {
  app: {},
  globalShortcut: {},
  ipcMain: { handle: (ch, fn) => handled.set(ch, fn), on: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tts-'));
const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
const vs = require('../voiceSettings.cjs');
const wiz = require('../voiceWizard.cjs');
const hotkey = require('../voiceHotkey.cjs');

afterAll(() => {
  Module._load = origLoad;
  homedirSpy.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('voice tts persistence + single IPC module', () => {
  beforeEach(() => {
    fs.rmSync(path.dirname(vs.storePath()), { recursive: true, force: true });
    handled.clear();
  });

  it('defaults false, round-trips, and preserves other keys/schemaVersion', async () => {
    expect(await vs.loadTtsEnabled()).toBe(false);
    await vs.save(vs.defaultsForPlatform());
    await vs.saveTtsEnabled(true);
    expect(await vs.loadTtsEnabled()).toBe(true);
    const raw = JSON.parse(fs.readFileSync(vs.storePath(), 'utf8'));
    expect(raw.ttsEnabled).toBe(true);
    expect(raw.schemaVersion).toBe(1);
    expect(raw.accelerator).toBeTruthy();
    await vs.saveTtsEnabled(false);
    expect(await vs.loadTtsEnabled()).toBe(false);
    await expect(vs.saveTtsEnabled('x')).rejects.toThrow();
  });

  it('hotkey save does not drop ttsEnabled', async () => {
    await vs.saveTtsEnabled(true);
    await vs.save(vs.defaultsForPlatform());
    expect(await vs.loadTtsEnabled()).toBe(true);
  });

  it('all voice:* handlers register from voiceHotkey; voiceWizard only exports functions', () => {
    expect(wiz.registerWizardHandlers).toBeUndefined();
    expect(handled.size).toBe(0);
    hotkey.registerHotkeyHandlers();
    for (const ch of ['voice:wizard-state', 'voice:wizard-complete', 'voice:get-turn-detector',
      'voice:set-turn-detector', 'voice:get-tts-enabled', 'voice:set-tts-enabled', 'voice:get-hotkey-config']) {
      expect(handled.has(ch)).toBe(true);
    }
  });

  it('IPC set/get tts round-trips', async () => {
    hotkey.registerHotkeyHandlers();
    expect(await handled.get('voice:set-tts-enabled')({}, true)).toEqual({ ok: true, ttsEnabled: true });
    expect(await handled.get('voice:get-tts-enabled')({})).toBe(true);
    await expect(handled.get('voice:set-tts-enabled')({}, 1)).rejects.toThrow();
  });
});
