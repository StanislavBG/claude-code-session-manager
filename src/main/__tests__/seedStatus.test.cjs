/**
 * seedStatus.test.cjs — unit tests for src/main/seedStatus.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/seedStatus.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let getSeedStatus;

// config.cjs (via seedSchedulerMcp/seedAgentPersonas) and each seed*.cjs
// module bake os.homedir() into top-level consts at first require — purge
// all of them alongside seedStatus.cjs so each test's tmpHome takes effect.
const MODULES_TO_RELOAD = [
  '../seedStatus.cjs',
  '../seedDevPlugin.cjs',
  '../seedSchedulerMcp.cjs',
  '../seedAgentPersonas.cjs',
  '../config.cjs',
];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-status-test-'));
  process.env.HOME = tmpHome;
  purgeRequireCache();
  ({ getSeedStatus } = require('../seedStatus.cjs'));
});

afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  purgeRequireCache();
});

const MARKER_NAMES = {
  'dev-plugin': '.dev-plugin-seeded',
  'scheduler-mcp': '.scheduler-mcp-seeded',
  'agent-personas': '.agent-personas-seeded',
};

function markerPath(id) {
  return path.join(tmpHome, '.claude', 'session-manager', MARKER_NAMES[id]);
}

function writeMarker(id, contents) {
  const p = markerPath(id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

test('no marker files at all → every seeder reports pending with a fix string', () => {
  const status = getSeedStatus();
  for (const id of Object.keys(MARKER_NAMES)) {
    expect(status[id].status).toBe('pending');
    expect(typeof status[id].fix).toBe('string');
    expect(status[id].fix.length).toBeGreaterThan(0);
  }
});

for (const id of Object.keys(MARKER_NAMES)) {
  test(`${id}: done:true marker → done`, () => {
    writeMarker(id, JSON.stringify({ done: true, attempts: 1, ts: '2026-01-01T00:00:00.000Z' }));
    expect(getSeedStatus()[id].status).toBe('done');
  });

  test(`${id}: done:false, attempts 1 reports failed`, () => {
    writeMarker(id, JSON.stringify({ done: false, attempts: 1, ts: '2026-01-01T00:00:00.000Z' }));
    expect(getSeedStatus()[id].status).toBe('failed');
  });

  test(`${id}: done:false, attempts >= max → exhausted`, () => {
    writeMarker(id, JSON.stringify({ done: false, attempts: 3, ts: '2026-01-01T00:00:00.000Z' }));
    expect(getSeedStatus()[id].status).toBe('exhausted');
  });

  test(`${id}: unparseable marker → pending, never throws`, () => {
    writeMarker(id, 'not json at all {{{');
    expect(() => getSeedStatus()).not.toThrow();
    expect(getSeedStatus()[id].status).toBe('pending');
  });

  test(`${id}: absent marker stays pending`, () => {
    // No file written for this id — directory may not even exist.
    expect(getSeedStatus()[id].status).toBe('pending');
  });
}

// agent-personas writes `{ seeded: [...], attempts, ts }` — no `done` field.
// Its status must come from the seeded set, built from the real PERSONAS export.
function personasMarker(seeded, attempts) {
  writeMarker('agent-personas', JSON.stringify({ seeded, attempts, ts: '2026-01-01T00:00:00.000Z' }));
}

test('agent-personas: every PERSONAS name seeded, attempts 0 → done', () => {
  const { PERSONAS } = require('../seedAgentPersonas.cjs');
  personasMarker([...PERSONAS], 0);
  expect(getSeedStatus()['agent-personas'].status).toBe('done');
});

test('agent-personas: every PERSONAS name seeded, attempts 1 → done', () => {
  const { PERSONAS } = require('../seedAgentPersonas.cjs');
  personasMarker([...PERSONAS], 1);
  expect(getSeedStatus()['agent-personas'].status).toBe('done');
});

test('agent-personas: fix text mentions the Agent Library, not the old skip wording', () => {
  const { fix } = getSeedStatus()['agent-personas'];
  expect(fix).toContain('Agent Library');
  expect(fix).not.toContain('skip any that already exist there');
});

test('agent-personas: only architect seeded, attempts 0 → pending', () => {
  personasMarker(['architect'], 0);
  expect(getSeedStatus()['agent-personas'].status).toBe('pending');
});

test('agent-personas: only architect seeded, attempts 1 → failed', () => {
  personasMarker(['architect'], 1);
  expect(getSeedStatus()['agent-personas'].status).toBe('failed');
});

test('agent-personas: only architect seeded, attempts 3 → exhausted', () => {
  personasMarker(['architect'], 3);
  expect(getSeedStatus()['agent-personas'].status).toBe('exhausted');
});

test('agent-personas: the real seeder run reports done', async () => {
  const savedDisable = process.env.SM_SEED_AGENT_PERSONAS_DISABLE;
  delete process.env.SM_SEED_AGENT_PERSONAS_DISABLE;
  try {
    const { seedAgentPersonas } = require('../seedAgentPersonas.cjs');
    await seedAgentPersonas({ logger: { log: () => {}, warn: () => {} } });
    expect(getSeedStatus()['agent-personas'].status).toBe('done');
  } finally {
    if (savedDisable === undefined) delete process.env.SM_SEED_AGENT_PERSONAS_DISABLE;
    else process.env.SM_SEED_AGENT_PERSONAS_DISABLE = savedDisable;
  }
});
