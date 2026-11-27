'use strict';
import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome, realHome, mod, srcDir;
const MODS = ['../personaUpgrade.cjs', '../../../seedAgentPersonas.cjs', '../../../config.cjs'];
const purge = () => { for (const m of MODS) { try { delete require.cache[require.resolve(m)]; } catch { /* */ } } };
const persona = (v, model, body) => `---\nname: architect\nmodel: ${model}\nseedVersion: ${v}\n---\n${body}\n`;
const sha = (text) => require('../../../seedAgentPersonas.cjs').personaBodyHash(text);
const installedPath = () => path.join(tmpHome, '.claude', 'agents', 'architect.md');

let realSched;
beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-upgrade-test-'));
  process.env.HOME = tmpHome;
  realSched = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = path.join(tmpHome, '.claude', 'session-manager');
  purge();
  mod = require('../personaUpgrade.cjs');
  srcDir = path.join(tmpHome, 'seed');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(path.dirname(installedPath()), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'architect.md'), persona(3, 'opus', 'NEW BODY'));
});
afterEach(() => {
  process.env.HOME = realHome;
  if (realSched === undefined) delete process.env.SM_SCHEDULER_HOME; else process.env.SM_SCHEDULER_HOME = realSched;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  purge();
});

test('skip recorded: edited persona behind bundled', () => {
  const r = mod.personaUpgradeFor('architect', persona(2, 'opus', 'MY BODY'), { shippedSeeds: {}, srcDir });
  expect(r).toMatchObject({ installedVersion: 2, bundledVersion: 3, edited: true, bundledBody: 'NEW BODY' });
});

test('shipped body is not edited', () => {
  const old = persona(2, 'opus', 'OLD');
  const r = mod.personaUpgradeFor('architect', old, { shippedSeeds: { architect: [{ bodySha256: sha(old), fm: {} }] }, srcDir });
  expect(r.edited).toBe(false);
});

test('same or newer returns null', () => {
  expect(mod.personaUpgradeFor('architect', persona(3, 'opus', 'X'), { shippedSeeds: {}, srcDir })).toBeNull();
  expect(mod.personaUpgradeFor('architect', persona(4, 'opus', 'X'), { shippedSeeds: {}, srcDir })).toBeNull();
});

test('take-new: backup, user model kept, body replaced', async () => {
  const old = persona(2, 'sonnet', 'MY BODY');
  fs.writeFileSync(installedPath(), old);
  const { backupPath, seedVersion } = await mod.takeBundledPersona('architect', { shippedSeeds: {}, srcDir });
  expect(seedVersion).toBe(3);
  expect(fs.readFileSync(backupPath, 'utf8')).toBe(old);
  const next = fs.readFileSync(installedPath(), 'utf8');
  expect(next).toContain('model: sonnet');
  expect(next).toContain('NEW BODY');
  expect(next).not.toContain('MY BODY');
  expect(next).toContain('seedVersion: 3');
});

test('dismiss until next bump', async () => {
  const text = persona(2, 'opus', 'MY');
  await mod.dismissPersonaUpgrade('architect', 3);
  expect(mod.readDismissals()).toEqual({ architect: 3 });
  expect(mod.personaUpgradeFor('architect', text, { shippedSeeds: {}, srcDir })).toBeNull();
  fs.writeFileSync(path.join(srcDir, 'architect.md'), persona(4, 'opus', 'NEWER'));
  expect(mod.personaUpgradeFor('architect', text, { shippedSeeds: {}, srcDir })).toMatchObject({ bundledVersion: 4 });
});

test('name outside PERSONAS refused; malformed dismissals read as {}', async () => {
  expect(mod.personaUpgradeFor('nope', persona(1, 'x', 'y'), { srcDir })).toBeNull();
  await expect(mod.dismissPersonaUpgrade('nope', 2)).rejects.toThrow();
  await expect(mod.dismissPersonaUpgrade('architect', 0)).rejects.toThrow();
  await expect(mod.takeBundledPersona('nope', { srcDir })).rejects.toThrow();
  const p = path.join(tmpHome, '.claude', 'session-manager');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'persona-upgrade-dismissals.json'), '{bad');
  expect(mod.readDismissals()).toEqual({});
});
