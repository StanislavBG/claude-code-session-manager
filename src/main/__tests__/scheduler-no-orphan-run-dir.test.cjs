/**
 * scheduler-no-orphan-run-dir.test.cjs — PRD 1120: pickRunDir() must not
 * mkdir a run directory until a dispatch actually commits (executeJob's
 * first write). A dispatch that aborts inside spawnJob before that point —
 * e.g. sessionSlots.acquire() returning null, the earliest exit in spawnJob
 * — must leave RUNS_DIR untouched.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-no-orphan-run-dir.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let originalSlots;
let scheduler;
let sessionSlots;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-no-orphan-rundir-'));
  process.env.HOME = tmpHome;
  originalSlots = process.env.SM_SESSION_SLOTS;
  scheduler = require('../scheduler.cjs');
  sessionSlots = require('../lib/sessionSlots.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalSlots === undefined) delete process.env.SM_SESSION_SLOTS;
  else process.env.SM_SESSION_SLOTS = originalSlots;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  sessionSlots.__resetForTests();
});

function runsDirEntryCount() {
  const runsDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs');
  try {
    return fs.readdirSync(runsDir).length;
  } catch {
    return 0;
  }
}

test('pickRunDir() allocates a runId/dir pair without creating the directory', () => {
  const before = runsDirEntryCount();
  const { runId, dir } = scheduler.pickRunDir();
  expect(runId).toBeTruthy();
  expect(fs.existsSync(dir)).toBe(false);
  expect(runsDirEntryCount()).toBe(before);
});

test('a dispatch that bails at slot-acquisition (earliest spawnJob exit) leaves no directory under RUNS_DIR', async () => {
  // Force sessionSlots.acquire() to return null immediately — no slots at all.
  process.env.SM_SESSION_SLOTS = '0';
  const before = runsDirEntryCount();

  const slug = `1120-slot-miss-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-no-orphan-rundir-project-'));
  try {
    await scheduler.spawnJob({ slug, cwd: projectCwd }, `run-${slug}`, path.join(
      tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', `run-${slug}`
    ), projectCwd);

    expect(runsDirEntryCount()).toBe(before);
    expect(fs.existsSync(path.join(
      tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', `run-${slug}`
    ))).toBe(false);
  } finally {
    delete process.env.SM_SESSION_SLOTS;
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
});
