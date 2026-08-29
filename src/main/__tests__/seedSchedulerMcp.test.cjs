/**
 * seedSchedulerMcp.test.cjs — unit tests for src/main/seedSchedulerMcp.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/seedSchedulerMcp.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let seedSchedulerMcp;

// config.cjs bakes os.homedir() into top-level consts at first require
// (allowedRoots/WRITE_PREFIXES, used by writeJsonSync) — must be purged
// alongside seedSchedulerMcp.cjs so each test's tmpHome takes effect.
const MODULES_TO_RELOAD = ['../seedSchedulerMcp.cjs', '../config.cjs'];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-scheduler-mcp-test-'));
  process.env.HOME = tmpHome;
  delete process.env.SM_SEED_SCHEDULER_MCP_DISABLE;
  purgeRequireCache();
  ({ seedSchedulerMcp } = require('../seedSchedulerMcp.cjs'));
});

afterEach(() => {
  process.env.HOME = realHome;
  delete process.env.SM_SEED_SCHEDULER_MCP_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  purgeRequireCache();
});

function markerPath() {
  return path.join(tmpHome, '.claude', 'session-manager', '.scheduler-mcp-seeded');
}

function claudeJsonPath() {
  return path.join(tmpHome, '.claude.json');
}

function silentLogger() {
  return { log: () => {}, warn: () => {} };
}

function readMarker() {
  return JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
}

test('fresh registration calls addFn with the absolute server path and writes done marker', async () => {
  const calls = [];
  const addFn = async (serverPath) => {
    calls.push(serverPath);
    return { ok: true, exitCode: 0 };
  };

  await seedSchedulerMcp({ logger: silentLogger(), addFn });

  expect(calls).toHaveLength(1);
  expect(path.isAbsolute(calls[0])).toBe(true);
  expect(calls[0].endsWith(path.join('scripts', 'scheduler-mcp-server.cjs'))).toBe(true);

  const marker = readMarker();
  expect(marker.done).toBe(true);
  expect(marker.attempts).toBe(0);
});

test('already-registered at user scope short-circuits without calling addFn', async () => {
  fs.writeFileSync(
    claudeJsonPath(),
    JSON.stringify({
      mcpServers: {
        'session-manager-scheduler': { type: 'stdio', command: 'node', args: ['/some/path/scheduler-mcp-server.cjs'] },
        fetch: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
      },
    })
  );
  let called = false;
  const addFn = async () => { called = true; return { ok: true }; };

  await seedSchedulerMcp({ logger: silentLogger(), addFn });

  expect(called).toBe(false);
  const marker = readMarker();
  expect(marker.done).toBe(true);

  // Untouched — the pre-existing registration (and sibling entries) stay as-is.
  const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf8'));
  expect(claudeJson.mcpServers['session-manager-scheduler'].args).toEqual(['/some/path/scheduler-mcp-server.cjs']);
  expect(claudeJson.mcpServers.fetch).toBeDefined();
});

test('done:true marker short-circuits without calling addFn', async () => {
  fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
  fs.writeFileSync(markerPath(), JSON.stringify({ done: true, attempts: 1, ts: '2026-01-01T00:00:00.000Z' }));
  let called = false;
  const addFn = async () => { called = true; return { ok: true }; };

  await seedSchedulerMcp({ logger: silentLogger(), addFn });

  expect(called).toBe(false);
});

test('SM_SEED_SCHEDULER_MCP_DISABLE=1 short-circuits', async () => {
  process.env.SM_SEED_SCHEDULER_MCP_DISABLE = '1';
  let called = false;
  const addFn = async () => { called = true; return { ok: true }; };

  await seedSchedulerMcp({ logger: silentLogger(), addFn });

  expect(called).toBe(false);
  expect(fs.existsSync(markerPath())).toBe(false);
});

test('a failed attempt bumps the counter and stops after MAX_ATTEMPTS', async () => {
  const addFn = async () => ({ ok: false, error: 'boom' });

  await seedSchedulerMcp({ logger: silentLogger(), addFn });
  expect(readMarker()).toMatchObject({ done: false, attempts: 1 });

  await seedSchedulerMcp({ logger: silentLogger(), addFn });
  expect(readMarker()).toMatchObject({ done: false, attempts: 2 });

  await seedSchedulerMcp({ logger: silentLogger(), addFn });
  expect(readMarker()).toMatchObject({ done: false, attempts: 3 });

  // MAX_ATTEMPTS reached — a 4th run must not call addFn again or bump further.
  let called = false;
  const trackedAddFn = async () => { called = true; return { ok: false, error: 'boom' }; };
  await seedSchedulerMcp({ logger: silentLogger(), addFn: trackedAddFn });

  expect(called).toBe(false);
  expect(readMarker()).toMatchObject({ done: false, attempts: 3 });
});
