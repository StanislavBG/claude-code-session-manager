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

const ALL_PERSONAS = ['architect', 'dev-lead', 'project-home-builder'];

test('fresh seed writes every persona file', async () => {
  await seedAgentPersonas({ logger: silentLogger() });

  for (const name of ALL_PERSONAS) {
    const dest = path.join(agentsDir(), `${name}.md`);
    expect(fs.existsSync(dest)).toBe(true);
    const bundled = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`), 'utf8');
    expect(fs.readFileSync(dest, 'utf8')).toBe(bundled);
  }

  const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a pre-existing persona file is left byte-identical', async () => {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const architect = path.join(agentsDir(), 'architect.md');
  const customContent = '# My custom architect\nnever overwrite me\n';
  fs.writeFileSync(architect, customContent);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(architect, 'utf8')).toBe(customContent);
  // dev-lead and project-home-builder had no pre-existing file, so they should still be seeded.
  expect(fs.existsSync(path.join(agentsDir(), 'dev-lead.md'))).toBe(true);
  expect(fs.existsSync(path.join(agentsDir(), 'project-home-builder.md'))).toBe(true);
});

test('a machine already fully seeded under the old done:true marker only picks up a newly added persona', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  // Legacy marker shape from before the seeded-set change — no `seeded` array.
  fs.writeFileSync(mPath, JSON.stringify({ done: true, attempts: 1, ts: '2026-01-01T00:00:00.000Z' }));
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(path.join(agentsDir(), 'architect.md'), 'old architect content\n');
  fs.writeFileSync(path.join(agentsDir(), 'dev-lead.md'), 'old dev-lead content\n');

  await seedAgentPersonas({ logger: silentLogger() });

  // Pre-existing files from the old run are untouched...
  expect(fs.readFileSync(path.join(agentsDir(), 'architect.md'), 'utf8')).toBe('old architect content\n');
  expect(fs.readFileSync(path.join(agentsDir(), 'dev-lead.md'), 'utf8')).toBe('old dev-lead content\n');
  // ...but the newly added persona is delivered.
  expect(fs.existsSync(path.join(agentsDir(), 'project-home-builder.md'))).toBe(true);

  const marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a machine already seeded under the new seeded-set marker picks up a newly added persona', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify({ seeded: ['architect', 'dev-lead'], attempts: 0, ts: '2026-01-01T00:00:00.000Z' }));

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(path.join(agentsDir(), 'project-home-builder.md'))).toBe(true);
  const marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a machine with every known persona already in the seeded set short-circuits without touching agents dir', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, JSON.stringify({ seeded: ALL_PERSONAS, attempts: 0, ts: '2026-01-01T00:00:00.000Z' }));

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(agentsDir())).toBe(false);
});

test('a corrupt/unparseable marker file still seeds correctly', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(mPath, '{ not valid json');

  await seedAgentPersonas({ logger: silentLogger() });

  for (const name of ALL_PERSONAS) {
    expect(fs.existsSync(path.join(agentsDir(), `${name}.md`))).toBe(true);
  }
});

test('the bundled project-home-builder persona contains no session-manager-repo paths', () => {
  const content = fs.readFileSync(
    path.join(__dirname, '..', '..', 'seed', 'agents', 'project-home-builder.md'),
    'utf8'
  );
  const forbidden = [
    'session-manager-operations/architecture/',
    '.claude/agents/',
    'session-manager-operations/design-mocks/',
    'scripts/',
    'npm run build:project-pages',
  ];
  for (const substr of forbidden) {
    expect(content).not.toContain(substr);
  }
});

test('SM_SEED_AGENT_PERSONAS_DISABLE=1 short-circuits', async () => {
  process.env.SM_SEED_AGENT_PERSONAS_DISABLE = '1';

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.existsSync(agentsDir())).toBe(false);
  expect(fs.existsSync(markerPath())).toBe(false);
});
