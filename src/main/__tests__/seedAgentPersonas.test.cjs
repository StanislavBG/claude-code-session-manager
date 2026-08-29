/**
 * seedAgentPersonas.test.cjs — unit tests for src/main/seedAgentPersonas.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/seedAgentPersonas.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let seedAgentPersonas;

// config.cjs bakes os.homedir() into top-level consts at first require
// (allowedRoots/WRITE_PREFIXES, used by writeJsonSync) — must be purged
// alongside seedAgentPersonas.cjs so each test's tmpHome takes effect.
const MODULES_TO_RELOAD = ['../seedAgentPersonas.cjs', '../config.cjs'];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-agent-personas-test-'));
  process.env.HOME = tmpHome;
  delete process.env.SM_SEED_AGENT_PERSONAS_DISABLE;
  purgeRequireCache();
  ({ seedAgentPersonas } = require('../seedAgentPersonas.cjs'));
});

afterEach(() => {
  process.env.HOME = realHome;
  delete process.env.SM_SEED_AGENT_PERSONAS_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  purgeRequireCache();
});

function agentsDir() {
  return path.join(tmpHome, '.claude', 'agents');
}

function markerPath() {
  return path.join(tmpHome, '.claude', 'session-manager', '.agent-personas-seeded');
}

function silentLogger() {
  return { log: () => {}, warn: () => {} };
}

test('fresh seed writes both persona files', async () => {
  await seedAgentPersonas({ logger: silentLogger() });

  const architect = path.join(agentsDir(), 'architect.md');
  const devLead = path.join(agentsDir(), 'dev-lead.md');
  expect(fs.existsSync(architect)).toBe(true);
  expect(fs.existsSync(devLead)).toBe(true);

  const bundledArchitect = fs.readFileSync(
    path.join(__dirname, '..', '..', 'seed', 'agents', 'architect.md'),
    'utf8'
  );
  expect(fs.readFileSync(architect, 'utf8')).toBe(bundledArchitect);

  const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  expect(marker.done).toBe(true);
});

test('a pre-existing persona file is left byte-identical', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const architect = path.join(agentsDir(), 'architect.md');
  const customContent = '# My custom architect\nnever overwrite me\n';
  fs.writeFileSync(architect, customContent);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(architect, 'utf8')).toBe(customContent);
  // dev-lead had no pre-existing file, so it should still be seeded.
  expect(fs.existsSync(path.join(agentsDir(), 'dev-lead.md'))).toBe(true);
});

test('done:true marker short-circuits without touching agents dir', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify({ done: true, attempts: 1, ts: '2026-01-01T00:00:00.000Z' }));

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(agentsDir())).toBe(false);
});

test('SM_SEED_AGENT_PERSONAS_DISABLE=1 short-circuits', async () => {
  process.env.SM_SEED_AGENT_PERSONAS_DISABLE = '1';

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(agentsDir())).toBe(false);
  expect(fs.existsSync(markerPath())).toBe(false);
});
