/**
 * resolveEpicModelSettings.test.cjs — resolveEpicModel precedence:
 * Epic override > persona model > Claude settings model > fallback.
 * Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/resolveEpicModelSettings.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveEpicModel } = require('../agentModelResolve.cjs');
const { readSettingsModel } = require('../modelCatalog.cjs');

let tmp;
let home;
let cwd;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-model-settings-'));
  home = path.join(tmp, 'home');
  cwd = path.join(tmp, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function writeSettings(dir, file, obj) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', file), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

const baseDeps = (epic, persona) => ({
  homeDir: () => home,
  validatePath: (p) => p,
  projectRootOf: (p) => p,
  readActiveIndex: () => ({ sessions: epic ? { e1: { claudeSessionId: 'sid', ...epic } } : {} }),
});

function resolve(epic, extra = {}, fallbackModel) {
  return resolveEpicModel({ cwd, claudeSessionId: 'sid', fallbackModel, deps: { ...baseDeps(epic), ...extra } });
}

test('readSettingsModel: local over project over user, skips empty/non-string', () => {
  const deps = { homeDir: () => home, projectRootOf: (p) => p };
  expect(readSettingsModel(cwd, deps)).toBeNull();
  writeSettings(home, 'settings.json', { model: 'opus' });
  expect(readSettingsModel(cwd, deps)).toBe('opus');
  writeSettings(cwd, 'settings.json', { model: 'haiku' });
  expect(readSettingsModel(cwd, deps)).toBe('haiku');
  writeSettings(cwd, 'settings.local.json', { model: '' });
  expect(readSettingsModel(cwd, deps)).toBe('haiku');
  writeSettings(cwd, 'settings.local.json', { model: 'fable' });
  expect(readSettingsModel(cwd, deps)).toBe('fable');
});

test('readSettingsModel never throws on unreadable settings', () => {
  writeSettings(home, 'settings.json', '{not json');
  expect(readSettingsModel(cwd, { homeDir: () => home, projectRootOf: (p) => p })).toBeNull();
  expect(readSettingsModel(cwd, { homeDir: () => { throw new Error('x'); } })).toBeNull();
});

test('agentless Epic uses the settings model', () => {
  writeSettings(home, 'settings.json', { model: 'opus' });
  expect(resolve({})).toBe('opus');
});

test('Epic model override beats the settings model; inherit override falls through to settings', () => {
  writeSettings(home, 'settings.json', { model: 'opus' });
  expect(resolve({ model: 'haiku' })).toBe('haiku');
  expect(resolve({ model: 'inherit' })).toBe('opus');
});

test('persona model beats the settings model; inherit persona uses settings', () => {
  writeSettings(home, 'settings.json', { model: 'opus' });
  const personaDir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(personaDir, { recursive: true });
  fs.writeFileSync(path.join(personaDir, 'pinned-agent.md'), '---\nmodel: haiku\n---\nBody');
  fs.writeFileSync(path.join(personaDir, 'inherit-agent.md'), '---\nmodel: inherit\n---\nBody');
  expect(resolve({ agentType: 'pinned-agent' })).toBe('haiku');
  expect(resolve({ agentType: 'inherit-agent' })).toBe('opus');
});

test('no settings model or unreadable settings falls back, and the result is never empty', () => {
  expect(resolve({})).toBe('sonnet');
  expect(resolve({}, {}, 'haiku')).toBe('haiku');
  writeSettings(home, 'settings.json', '{broken');
  expect(resolve({})).toBe('sonnet');
  expect(resolve(null)).toBe('sonnet');
});
