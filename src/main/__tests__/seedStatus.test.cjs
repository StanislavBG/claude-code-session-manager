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

  test(`${id}: done:false, attempts below max → pending`, () => {
    writeMarker(id, JSON.stringify({ done: false, attempts: 1, ts: '2026-01-01T00:00:00.000Z' }));
    expect(getSeedStatus()[id].status).toBe('pending');
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

  test(`${id}: missing marker file → pending`, () => {
    // No file written for this id — directory may not even exist.
    expect(getSeedStatus()[id].status).toBe('pending');
  });
}
