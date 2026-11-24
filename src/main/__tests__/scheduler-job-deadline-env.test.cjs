/**
 * scheduler-job-deadline-env.test.cjs — executeJob hands the spawned
 * `claude -p` SM_SCHEDULER_JOB_DEADLINE_MS (epoch ms when the wall-clock
 * budget watchdog stops the job), so a tool the job runs can stop cleanly
 * first. A budgetExempt job gets no deadline.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-job-deadline-env.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let executeJob;
let computeJobBudgetMs;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-job-deadline-env-'));
  process.env.HOME = tmpHome;
  ({ executeJob } = require('../scheduler.cjs'));
  ({ computeJobBudgetMs } = require('../scheduler/budget.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

// Stub `claude`: dumps the deadline env (null when absent) and exits 0.
function writeClaudeStub() {
  return claudeStub.writeClaudeStub({ body: `
    const fs = require('fs');
    const path = require('path');
    const has = Object.prototype.hasOwnProperty.call(process.env, 'SM_SCHEDULER_JOB_DEADLINE_MS');
    fs.writeFileSync(path.join(process.cwd(), 'env.marker'), JSON.stringify({
      has,
      value: has ? process.env.SM_SCHEDULER_JOB_DEADLINE_MS : null,
    }), 'utf8');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
}

async function runJob(extra) {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-job-deadline-main-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-job-deadline-run-'));
  try {
    const slug = `3888-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
    fs.mkdirSync(prdsDir, { recursive: true });
    fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Verify the deadline env.', 'utf8');
    process.env.SM_CLAUDE_BIN = writeClaudeStub();
    const before = Date.now();
    const result = await executeJob({ slug, cwd: mainCwd, ...extra }, runDir, mainCwd, () => Promise.resolve());
    const after = Date.now();
    expect(result.exitCode).toBe(0);
    const marker = JSON.parse(fs.readFileSync(path.join(mainCwd, 'env.marker'), 'utf8'));
    return { marker, before, after };
  } finally {
    fs.rmSync(mainCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

test('a budgeted job gets SM_SCHEDULER_JOB_DEADLINE_MS = env-build time + its budget', async () => {
  const { marker, before, after } = await runJob({ estimateMinutes: 10 });
  const budgetMs = computeJobBudgetMs(10);
  expect(marker.has).toBe(true);
  expect(marker.value).toMatch(/^\d+$/);
  const deadline = Number(marker.value);
  expect(deadline).toBeGreaterThanOrEqual(before + budgetMs);
  expect(deadline).toBeLessThanOrEqual(after + budgetMs);
});

test('a budgetExempt job gets no SM_SCHEDULER_JOB_DEADLINE_MS', async () => {
  const { marker } = await runJob({ estimateMinutes: 10, budgetExempt: true });
  expect(marker.has).toBe(false);
});
