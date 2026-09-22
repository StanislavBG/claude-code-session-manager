/**
 * seedValidatorPersona.test.cjs — covers the `validator` persona's delivery
 * through seedAgentPersonas.cjs's existing "names not yet in `seeded`" path.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/seedValidatorPersona.test.cjs
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-validator-persona-test-'));
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

const ALL_PERSONAS = ['architect', 'dev-lead', 'project-home-builder', 'validator'];
const seedSrc = (name) => path.join(__dirname, '..', '..', 'seed', 'agents', `${name}.md`);

test('a fresh homedir gets all four persona files', async () => {
  await seedAgentPersonas({ logger: silentLogger() });

  for (const name of ALL_PERSONAS) {
    const dest = path.join(agentsDir(), `${name}.md`);
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe(fs.readFileSync(seedSrc(name), 'utf8'));
  }

  const marker = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('a homedir whose marker already lists the first three receives validator.md, and the other three files are byte-identical before and after', async () => {
  const mPath = markerPath();
  fs.mkdirSync(path.dirname(mPath), { recursive: true });
  fs.writeFileSync(
    mPath,
    JSON.stringify({ seeded: ['architect', 'dev-lead', 'project-home-builder'], attempts: 0, ts: '2026-01-01T00:00:00.000Z' })
  );
  fs.mkdirSync(agentsDir(), { recursive: true });
  const preExisting = {};
  for (const name of ['architect', 'dev-lead', 'project-home-builder']) {
    const content = `existing ${name} content\n`;
    fs.writeFileSync(path.join(agentsDir(), `${name}.md`), content);
    preExisting[name] = content;
  }

  expect(fs.existsSync(path.join(agentsDir(), 'validator.md'))).toBe(false);

  await seedAgentPersonas({ logger: silentLogger() });

  expect(fs.readFileSync(path.join(agentsDir(), 'validator.md'), 'utf8')).toBe(fs.readFileSync(seedSrc('validator'), 'utf8'));

  for (const name of ['architect', 'dev-lead', 'project-home-builder']) {
    expect(fs.readFileSync(path.join(agentsDir(), `${name}.md`), 'utf8')).toBe(preExisting[name]);
  }

  const marker = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  expect(marker.seeded.sort()).toEqual([...ALL_PERSONAS].sort());
});

test('the seeded validator body is under AGENT_BODY_CHAR_CAP and contains both required sentinel lines', () => {
  const { AGENT_BODY_CHAR_CAP } = require('../lib/agentModelResolve.cjs');
  const { splitFrontmatter } = require('../lib/prdFrontmatter.cjs');
  const raw = fs.readFileSync(seedSrc('validator'), 'utf8');
  const { body } = splitFrontmatter(raw);
  const trimmed = body.trim();

  expect(trimmed.length).toBeLessThan(AGENT_BODY_CHAR_CAP);
  expect(trimmed).toContain('VALIDATION: <slug> VERIFIED');
  expect(trimmed).toContain('SCHEDULER_VERDICT: PASS');
  expect(trimmed).not.toContain('Do not touch:');
  expect(trimmed).not.toContain('Report explicitly:');
  expect(trimmed.endsWith('report them.')).toBe(true);
});
