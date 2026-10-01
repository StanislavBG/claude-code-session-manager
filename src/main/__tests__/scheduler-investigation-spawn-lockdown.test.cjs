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
let HEADLESS_DISALLOWED_TOOLS;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-investigation-spawn-'));
  process.env.HOME = tmpHome;
  ({ spawnInvestigation, HEADLESS_DISALLOWED_TOOLS } = require('../scheduler.cjs'));
});

afterAll(async () => {
  // spawnInvestigation's onExit handler (fired when the child process exits,
  // AFTER this file's waitForMarker already observed the marker it wrote)
  // kicks off its own mutate()/tickQueue() calls fire-and-forget — same
  // shape scheduler-looks-done.test.cjs documents for reverifyNeedsReview's
  // own call to spawnInvestigation. Give that in-flight work a moment to
  // settle onto tmpHome before HOME is restored and tmpHome is removed, or
  // it can race either one (observed: an intermittent ENOTEMPTY tearing down
  // the shared vitest sandbox home when this wait was absent).
  await new Promise((r) => setTimeout(r, 500));
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
  git(['init', '-b', 'main'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
  fs.writeFileSync(path.join(cwd, 'README.md'), 'x');
  git(['add', 'README.md'], cwd);
  git(['commit', '-m', 'init'], cwd);

  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-investigation-run-'));
  process.env.SM_CLAUDE_BIN = writeClaudeStub();

  // status 'failed' (not 'needs_review') with none of the resume-recovery /
  // mechanical-recovery / stray-checkout / depth-cap fields set — every
  // pre-spawn guard in spawnInvestigation falls through so it reaches the
  // real spawn.
  const job = { slug: '99-example-lockdown-probe', status: 'failed', cwd };

  try {
    const result = await spawnInvestigation(job, runDir);
    expect(result).toEqual({ deferred: false });

    const marker = await waitForMarker(path.join(cwd, 'investigation-argv.marker'));

    const idx = marker.argv.indexOf('--disallowedTools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(marker.argv[idx + 1]).toBe(HEADLESS_DISALLOWED_TOOLS.join(','));
    // Never last, never right before the prompt: the variadic list must be
    // ended by another flag.
    expect(marker.argv[idx + 2]).toMatch(/^--/);

    // A headless run has no later turn to receive a background task's report.
    expect(marker.disableBackgroundTasks).toBe('1');

    const shimDir = path.join(tmpHome, '.claude', 'session-manager', 'bin');
    expect(marker.path.split(path.delimiter)).toContain(shimDir);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
