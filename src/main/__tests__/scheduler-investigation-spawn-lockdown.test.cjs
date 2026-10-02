/**
 * scheduler-investigation-spawn-lockdown.test.cjs — follow-up to commit
 * 781793f1. spawnInvestigation (src/main/scheduler.cjs) is the auto-fix/RCA
 * probe: it launches its OWN headless `claude -p` child with a hand-rolled
 * argv/env separate from executeJob's. 781793f1 only wired executeJob's
 * spawn with --disallowedTools, the timeout-shim PATH addition, and
 * CLAUDE_CODE_DISABLE_BACKGROUND_TASKS — this proves the investigation
 * probe's REAL spawned child now carries the same three.
 *
 * spawnInvestigation is fire-and-forget: it returns { deferred: false } right
 * after the child is spawned, without awaiting its exit (see
 * scheduler-looks-done.test.cjs's comment on the same shape, re:
 * reverifyNeedsReview's caller) — so this test polls for the stub's marker
 * file rather than trusting the awaited return value to mean "the child
 * already ran".
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — the
 * timeout-shim dir, queue.json, and the supervisor-record dir are all baked
 * into top-level consts / os.homedir() reads at require time (same reason as
 * scheduler-reap-dead-running-jobs.test.cjs).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-investigation-spawn-lockdown.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let spawnInvestigation;
let _mutateForTests;
let tickQueue;
let bustCwdCache;

// Set by the test, right after it creates them, so afterAll can wait for the
// onExit handler's in-flight work before removing tmpHome, then do the
// cleanup itself (see afterAll).
let pendingCwd = null;
let pendingRunDir = null;
let pendingLogPath = null;

// Copied from HEADLESS_DISALLOWED_TOOLS in scheduler.cjs (about line 5622) —
// a literal, not an import of the list under test. Comparing against the
// same binding the production code exports would still pass if that list
// were ever emptied by mistake; a literal catches it.
const EXPECTED_HEADLESS_DISALLOWED_TOOLS = [
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Monitor',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-investigation-spawn-'));
  process.env.HOME = tmpHome;
  ({ spawnInvestigation, _mutateForTests, tickQueue } = require('../scheduler.cjs'));
  ({ bustCwdCache } = require('../lib/queueStore.cjs'));
});

// Polls `logPath` for `substring` — at most 5s, every 25ms — instead of
// trusting a fixed sleep to have been long enough. Fails with a clear
// message on timeout rather than hanging or silently racing.
async function waitForLogLine(logPath, substring, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    if (text.includes(substring)) return text;
    if (Date.now() >= deadline) {
      throw new Error(`HALT: "${substring}" never appeared in ${logPath} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

afterAll(async () => {
  // spawnInvestigation's onExit handler (fired when the child process exits,
  // AFTER this file's waitForMarker already observed the marker it wrote)
  // kicks off its own mutate()/tickQueue() calls fire-and-forget — same
  // shape scheduler-looks-done.test.cjs documents for reverifyNeedsReview's
  // own call to spawnInvestigation. Wait for the condition that work needs
  // to have settled, instead of a fixed sleep: first the handler's own
  // "investigation exit code=" log line, then our own mutate()/tickQueue()
  // calls — which queue strictly behind the handler's fire-and-forget ones,
  // so ours only resolve once theirs already have. Only then is it safe to
  // remove tmpHome, or the two can race (observed: an intermittent ENOTEMPTY
  // tearing down the shared vitest sandbox home when this wait was absent).
  if (pendingLogPath) {
    await waitForLogLine(pendingLogPath, 'investigation exit code=');
  }
  if (typeof _mutateForTests === 'function') await _mutateForTests(() => {}).catch(() => {});
  if (typeof tickQueue === 'function') await tickQueue().catch(() => {});
  if (pendingCwd) fs.rmSync(pendingCwd, { recursive: true, force: true });
  if (pendingRunDir) fs.rmSync(pendingRunDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

function git(args, cwd) {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Stub `claude` binary: dumps its own argv plus the two env vars this test
// cares about into a marker file, then emits a stream-json success result
// and exits 0 — same technique as scheduler-prd-persona-spawn.test.cjs
// (argv) and scheduler-bash-timeout-env.test.cjs (env).
function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'investigation-argv.marker'), JSON.stringify({
      argv: process.argv.slice(2),
      path: process.env.PATH || '',
      disableBackgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS || null,
    }), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

// spawnInvestigation returns before the child exits (fire-and-forget), so
// poll for the marker file rather than trusting the awaited return value.
// Bounded (PRD_AUTHORING.md §1) — 100 x 50ms = 5s, never an unbounded wait.
async function waitForMarker(markerPath) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(markerPath)) return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`HALT: ${markerPath} never appeared after 5s — spawnInvestigation likely skipped the spawn`);
}

test('spawnInvestigation: the real probe child carries --disallowedTools, the timeout-shim PATH, and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', async () => {
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-investigation-cwd-'));
  pendingCwd = cwd; // afterAll cleans this up, after waiting for onExit to settle
  git(['init', '-b', 'main'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'x');
  git(['add', 'README.md'], cwd);
  git(['commit', '-m', 'init'], cwd);

  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-investigation-run-'));
  pendingRunDir = runDir; // afterAll cleans this up, after waiting for onExit to settle
  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  // status 'failed' (not 'needs_review') with none of the resume-recovery /
  // mechanical-recovery / stray-checkout / depth-cap fields set — every
  // pre-spawn guard in spawnInvestigation falls through so it reaches the
  // real spawn.
  const job = { slug: '99-example-lockdown-probe', status: 'failed', cwd };
  // scheduler.cjs's spawnInvestigation builds this same path (about line
  // 6601) — the onExit handler's final log line lands here.
  pendingLogPath = path.join(runDir, `${job.slug}.investigation.log`);

  // Register cwd as a live project and give it a real queue.json row for
  // `job`. spawnInvestigation re-reads the live row before it spawns (it
  // must fail closed if the row can't be found) — this test calls
  // spawnInvestigation directly, bypassing reverifyNeedsReview, so without
  // this registration the live-row check would see no row and skip the
  // spawn, same as scheduler-gate-shadow.test.cjs's setup() does for the
  // same reason.
  const slugDir = path.join(tmpHome, '.claude', 'projects', 'sm-investigation-lockdown-slug');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 't.jsonl'), JSON.stringify({ cwd }) + '\n');
  bustCwdCache();
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs: [job] }, null, 2));

  const result = await spawnInvestigation(job, runDir);
  expect(result).toEqual({ deferred: false });

  const marker = await waitForMarker(path.join(cwd, 'investigation-argv.marker'));

  const idx = marker.argv.indexOf('--disallowedTools');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(marker.argv[idx + 1]).toBe(EXPECTED_HEADLESS_DISALLOWED_TOOLS.join(','));
  // Never last, never right before the prompt: the variadic list must be
  // ended by another flag.
  expect(marker.argv[idx + 2]).toMatch(/^--/);

  // A headless run has no later turn to receive a background task's report.
  expect(marker.disableBackgroundTasks).toBe('1');

  const shimDir = path.join(tmpHome, '.claude', 'session-manager', 'bin');
  expect(marker.path.split(path.delimiter)).toContain(shimDir);
  // cwd/runDir cleanup happens in afterAll, after the onExit handler's own
  // fire-and-forget work (triggered by the child exiting, which may still be
  // in flight here) has settled — removing them here would race that work.
});
