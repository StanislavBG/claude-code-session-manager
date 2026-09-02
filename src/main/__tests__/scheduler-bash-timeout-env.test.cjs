/**
 * scheduler-bash-timeout-env.test.cjs — PRD 1097.
 *
 * A headless `claude -p` job inherits the harness's 120s default foreground
 * Bash timeout. Any legit gate command (a test suite, a build) that runs
 * long gets auto-backgrounded, and the tool result promises a notification
 * that a single-shot headless run can never receive — the run dead-ends
 * with no commit and no verdict. The fix is to raise
 * BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS on the spawned child's env.
 *
 * This proves:
 *   1. executeJob's real spawned child actually receives both env vars, with
 *      the exported constant values (not just that the constants exist).
 *   2. BASH_MAX_TIMEOUT_MS stays strictly below IDLE_OUTPUT_KILL_MS — the
 *      coupling that makes this more than a one-liner: a long foreground
 *      Bash emits no stream-json events, so the log mtime stalls and the
 *      idle-tail watchdog would SIGTERM the job mid-gate if the two ever
 *      crossed.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-bash-timeout-env.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let executeJob;
let BASH_DEFAULT_TIMEOUT_MS;
let BASH_MAX_TIMEOUT_MS;
let IDLE_OUTPUT_KILL_MS;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bash-timeout-env-'));
  process.env.HOME = tmpHome;
  ({ executeJob, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, IDLE_OUTPUT_KILL_MS } = require('../scheduler.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

// Stub `claude` binary: dumps the two env vars it received into a marker
// file, then emits a stream-json success result and exits 0.
function writeClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-env-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'env.marker'), JSON.stringify({
      BASH_DEFAULT_TIMEOUT_MS: process.env.BASH_DEFAULT_TIMEOUT_MS,
      BASH_MAX_TIMEOUT_MS: process.env.BASH_MAX_TIMEOUT_MS,
    }), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

test('BASH_MAX_TIMEOUT_MS stays strictly below IDLE_OUTPUT_KILL_MS with real margin', () => {
  expect(typeof BASH_DEFAULT_TIMEOUT_MS).toBe('number');
  expect(typeof BASH_MAX_TIMEOUT_MS).toBe('number');
  expect(typeof IDLE_OUTPUT_KILL_MS).toBe('number');
  expect(BASH_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(BASH_MAX_TIMEOUT_MS);
  expect(BASH_MAX_TIMEOUT_MS).toBeLessThan(IDLE_OUTPUT_KILL_MS);
  // Real margin, not a razor's edge.
  expect(IDLE_OUTPUT_KILL_MS - BASH_MAX_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
});

test('executeJob spawns the executor child with BASH_DEFAULT_TIMEOUT_MS and BASH_MAX_TIMEOUT_MS set', async () => {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bash-timeout-main-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-bash-timeout-run-'));
  try {
    const slug = `1097-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Verify the env vars are set.', 'utf8');
    process.env.SM_CLAUDE_BIN = writeClaudeStub();

    const job = { slug, cwd: mainCwd };
    const result = await executeJob(job, runDir, mainCwd, () => Promise.resolve());

    expect(result.exitCode).toBe(0);
    const marker = JSON.parse(fs.readFileSync(path.join(mainCwd, 'env.marker'), 'utf8'));
    expect(marker.BASH_DEFAULT_TIMEOUT_MS).toBe(String(BASH_DEFAULT_TIMEOUT_MS));
    expect(marker.BASH_MAX_TIMEOUT_MS).toBe(String(BASH_MAX_TIMEOUT_MS));
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
