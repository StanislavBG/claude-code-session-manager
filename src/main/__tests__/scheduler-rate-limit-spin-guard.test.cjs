/**
 * scheduler-rate-limit-spin-guard.test.cjs — PRD 1119 end-to-end repro of the
 * 2026-09-05 incident: a human pressed Resume/Run now on job 204, and for the
 * next hour the scheduler dispatched it, watched it 429 in seconds, reset it
 * to pending (halt-reset), and dispatched it again — 291 times, one every
 * ~12s — because setPaused()'s manual-override cooldown suppressed WRITING
 * the rate_limit pause for the whole 5-minute window, even though every one
 * of those 429s was a brand-new observation from a run that started AFTER
 * the human's clear.
 *
 * This drives the REAL dispatch path (spawnJob, via a stub `claude` binary
 * that always 429s in well under a second) repeatedly, immediately after a
 * simulated manual Resume, and asserts the scheduler engages a genuine pause
 * almost immediately — never anywhere near the 291-dispatch runaway, and
 * never past the documented CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD hard cap
 * even in the worst case. Compressed in wall-clock time (a stub exits in
 * milliseconds, not the ~12s a real `claude -p` round trip took) — the
 * assertion is on DISPATCH COUNT, which is what the fix actually bounds,
 * not on wall-clock duration.
 *
 * Run: timeout 60 npx vitest run src/main/__tests__/scheduler-rate-limit-spin-guard.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rate-limit-spin-guard-'));
  process.env.HOME = tmpHome;
  // Worktree isolation is irrelevant to this repro (it's about pause
  // suppression, not tree isolation) and each real `git worktree add` adds
  // real wall-clock overhead this test does not need to pay 40 times over.
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, 'spin-guard-project-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  queueStore.bustCwdCache();
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queuePath = path.join(stateDir, 'queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ jobs }, null, 2));
  return queuePath;
}

// Stub `claude` binary: always dies as a rate limit, in well under 30s (same
// technique as scheduler-prd-persona-spawn.test.cjs's argv-marker stub) —
// emits the canonical 429 signal detectRateLimitInLog looks for, then exits
// non-zero almost instantly, and bumps a counter file each invocation so the
// test can assert exactly how many times it was actually spawned.
function writeAlways429ClaudeStub(counterPath) {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-429-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(counterPath)}, 'x');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error_status: 429 }) + '\\n');
    process.exit(1);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

test('a manual Resume immediately followed by a permanently-429ing job never produces a runaway dispatch loop', async () => {
  const projectCwd = fs.mkdtempSync(path.join(tmpHome, 'spin-guard-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const slug = `1119-spin-guard-${process.pid}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');

  const counterPath = path.join(tmpHome, 'dispatch-count.txt');
  fs.writeFileSync(counterPath, '');
  process.env.SM_CLAUDE_BIN = writeAlways429ClaudeStub(counterPath);

  writeProjectQueue(projectCwd, [
    { slug, status: 'pending', cwd: projectCwd },
  ]);

  // The human just pressed Resume/Run now — this is the exact call clearPause
  // makes from the IPC handlers, and it starts the 5-minute cooldown window.
  await scheduler.clearPause('manual');

  const job = { slug, cwd: projectCwd };

  // Simulate the tick loop's dispatch decision being driven repeatedly "over
  // ten minutes" — compressed here to however many cycles a permanently-429
  // job can actually complete, since each cycle is a real (fast) subprocess
  // spawn rather than a real 12s `claude -p` round trip. tickQueue()'s own
  // paused early-return (unchanged by this PRD) is exactly what this loop
  // reproduces by hand: stop dispatching the moment the queue is paused.
  const MAX_TICKS = 40;
  for (let i = 0; i < MAX_TICKS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const state = await queueStore.readMerged();
    if (state.paused) break;
    const row = state.jobs.find((j) => j.slug === slug);
    if (!row || row.status !== 'pending') break;
    const runId = `run-${i}`;
    const runDir = path.join(scheduler.RUNS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await scheduler.spawnJob(job, runId, runDir, projectCwd);
  }

  const dispatchCount = fs.readFileSync(counterPath, 'utf8').length;
  expect(dispatchCount).toBeLessThanOrEqual(scheduler.CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD);
  expect(dispatchCount).toBeGreaterThan(0);
  expect(dispatchCount).toBeLessThan(10); // nowhere near the 291-dispatch incident

  const finalState = await queueStore.readMerged();
  expect(finalState.paused).toBeTruthy();
  expect(finalState.paused.reason).toBe('rate_limit');
  expect(finalState.jobs.find((j) => j.slug === slug).status).toBe('pending');
});
