/**
 * scheduler-job-budget.test.cjs — per-job wall-clock budget derived from the
 * PRD's own `estimateMinutes`, and the classifier that parks an over-budget
 * job `needs_review` (never 'failed', never silently 'completed').
 *
 * Closes the gap `findOverrunningJobs` deliberately leaves open (escalation
 * only, never kills — see its own header): p50/p90/max across 606 run-meta
 * records since 2026-08-25 was 13m/60m/240m against a concurrencyCap of 4,
 * so a chatty-but-runaway executor that keeps emitting output (never
 * tripping IDLE_OUTPUT_KILL_MS) could hold a dispatch slot for hours with
 * nothing to notice or act on it.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-job-budget.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (CLAUDE.md).
import { test } from 'vitest';
const assert = require('node:assert/strict');
const {
  computeJobBudgetMs,
  classifyBudgetKill,
  isJobBudgetExempt,
  shouldKillForBudget,
  resolveBudgetKillOutcome,
  selectAutoFixTargets,
  JOB_BUDGET_FACTOR,
  JOB_BUDGET_FLOOR_MS,
  JOB_BUDGET_CEILING_MS,
} = require('../scheduler.cjs');

// ---------- computeJobBudgetMs: both clamps ----------

test('computeJobBudgetMs: a mid-size estimate is factor*estimate, no clamp hit', () => {
  // 30m * 3 = 90m — comfortably between the 45m floor and the 180m ceiling.
  const budgetMs = computeJobBudgetMs(30);
  assert.strictEqual(budgetMs, 90 * 60_000);
});

test('computeJobBudgetMs: the floor clamp — a tiny/missing/zero estimate never goes below 45m', () => {
  // 5m * 3 = 15m, well under the 45m floor.
  assert.strictEqual(computeJobBudgetMs(5), JOB_BUDGET_FLOOR_MS);
  // Missing/zero estimate is treated as 0 — the floor dominates, no special-casing.
  assert.strictEqual(computeJobBudgetMs(0), JOB_BUDGET_FLOOR_MS);
  assert.strictEqual(computeJobBudgetMs(null), JOB_BUDGET_FLOOR_MS);
  assert.strictEqual(computeJobBudgetMs(undefined), JOB_BUDGET_FLOOR_MS);
});

test('computeJobBudgetMs: the ceiling clamp — a huge estimate never exceeds 180m', () => {
  // 200m * 3 = 600m, way past the 180m ceiling.
  assert.strictEqual(computeJobBudgetMs(200), JOB_BUDGET_CEILING_MS);
});

test('computeJobBudgetMs: honors caller overrides when neither clamp is hit', () => {
  const budgetMs = computeJobBudgetMs(5, { factor: 2, floorMs: 1000, ceilingMs: 3_600_000 });
  assert.strictEqual(budgetMs, 10 * 60_000);
});

test('JOB_BUDGET_FACTOR/FLOOR/CEILING are the named constants the AC requires (3x, 45m, 180m)', () => {
  assert.strictEqual(JOB_BUDGET_FACTOR, 3);
  assert.strictEqual(JOB_BUDGET_FLOOR_MS, 45 * 60_000);
  assert.strictEqual(JOB_BUDGET_CEILING_MS, 180 * 60_000);
});

// ---------- shouldKillForBudget: under vs over budget ----------

test('shouldKillForBudget: a job under budget is untouched', () => {
  assert.strictEqual(shouldKillForBudget(44 * 60_000, 45 * 60_000), false);
});

test('shouldKillForBudget: a job at or past its budget fires', () => {
  assert.strictEqual(shouldKillForBudget(45 * 60_000, 45 * 60_000), true);
  assert.strictEqual(shouldKillForBudget(241 * 60_000, 90 * 60_000), true);
});

// ---------- classifyBudgetKill: the needs_review park + evidence threading ----------

test('classifyBudgetKill: a job not killed by the budget watchdog is untouched (returns null)', () => {
  assert.strictEqual(classifyBudgetKill({ killedByWatchdog: 'idle-tail', exitCode: 143 }, null), null);
  assert.strictEqual(classifyBudgetKill({ killedByWatchdog: null, exitCode: 0 }, null), null);
  assert.strictEqual(classifyBudgetKill(null, null), null);
});

test('classifyBudgetKill: an over-budget job parks needs_review with the exact reason string, no evidence', () => {
  const res = {
    killedByWatchdog: 'budget',
    exitCode: 143,
    budgetKillReason: 'wall-clock budget exceeded: ran 241m against a 90m budget (estimateMinutes=30)',
  };
  const decision = classifyBudgetKill(res, null);
  assert.strictEqual(decision.status, 'needs_review');
  assert.strictEqual(decision.reason, 'wall-clock budget exceeded: ran 241m against a 90m budget (estimateMinutes=30)');
  assert.strictEqual(decision.landedCommit, null);
});

test('classifyBudgetKill: an over-budget job with a verified landed commit is still adjudicated on git evidence, not discarded', () => {
  const res = {
    killedByWatchdog: 'budget',
    exitCode: 143,
    budgetKillReason: 'wall-clock budget exceeded: ran 91m against a 90m budget (estimateMinutes=30)',
  };
  const decision = classifyBudgetKill(res, 'deadbeef1234567890');
  // Never 'failed' or 'completed' just because a commit landed — still parked
  // for review, but the evidence is threaded onto the row rather than dropped.
  assert.strictEqual(decision.status, 'needs_review');
  assert.strictEqual(decision.landedCommit, 'deadbeef1234567890');
});

// ---------- isJobBudgetExempt: quietMachine + explicit opt-out ----------

test('isJobBudgetExempt: a quietMachine job is exempt', () => {
  assert.strictEqual(isJobBudgetExempt({ quietMachine: true }), true);
});

test('isJobBudgetExempt: a PRD with an explicit budgetExempt opt-out is exempt', () => {
  assert.strictEqual(isJobBudgetExempt({ budgetExempt: true }), true);
});

test('isJobBudgetExempt: an ordinary job is not exempt', () => {
  assert.strictEqual(isJobBudgetExempt({}), false);
  assert.strictEqual(isJobBudgetExempt({ quietMachine: false, budgetExempt: false }), false);
});

// ---------- resolveBudgetKillOutcome: the watchdog-tick vs natural-exit race ----------

test('resolveBudgetKillOutcome: a genuine signal kill (exit 143) is trusted', () => {
  const outcome = resolveBudgetKillOutcome({
    killedByWatchdog: 'budget', killedBySignal: true, durationMs: 91 * 60_000, jobBudgetMs: 90 * 60_000, estimateMinutes: 30,
  });
  assert.strictEqual(outcome.killedByWatchdog, 'budget');
  assert.strictEqual(outcome.budgetKillReason, 'wall-clock budget exceeded: ran 91m against a 90m budget (estimateMinutes=30)');
});

test('resolveBudgetKillOutcome: a race where the child exits cleanly (exit 0) in the same tick is NOT trusted as a budget kill', () => {
  // The watchdog's action() fired (stamping ctx.killedByWatchdog='budget')
  // but the agent had already exited on its own with exit 0 — killTree()
  // was a no-op against an already-dead pid. Must never misclassify a
  // genuinely successful run as needs_review.
  const outcome = resolveBudgetKillOutcome({
    killedByWatchdog: 'budget', killedBySignal: false, durationMs: 90 * 60_000, jobBudgetMs: 90 * 60_000, estimateMinutes: 30,
  });
  assert.strictEqual(outcome.killedByWatchdog, null);
  assert.strictEqual(outcome.budgetKillReason, null);
});

test('resolveBudgetKillOutcome: a race where the child fails on its own (exit 1, unrelated) is NOT trusted as a budget kill', () => {
  const outcome = resolveBudgetKillOutcome({
    killedByWatchdog: 'budget', killedBySignal: false, durationMs: 90 * 60_000, jobBudgetMs: 90 * 60_000, estimateMinutes: 30,
  });
  assert.strictEqual(outcome.killedByWatchdog, null);
});

test('resolveBudgetKillOutcome: no watchdog fired at all — untouched', () => {
  const outcome = resolveBudgetKillOutcome({
    killedByWatchdog: 'idle-tail', killedBySignal: true, durationMs: 25 * 60_000, jobBudgetMs: 90 * 60_000, estimateMinutes: 30,
  });
  assert.strictEqual(outcome.killedByWatchdog, 'idle-tail');
  assert.strictEqual(outcome.budgetKillReason, null);
});

// ---------- selectAutoFixTargets: a budget-killed job never gets auto-retried ----------

test('selectAutoFixTargets: a budget_exceeded needs_review job is excluded — it parks for a human/ladder decision, never a fix-plan', () => {
  const jobs = [
    { slug: '10-budget-victim', status: 'needs_review', verifierVerdict: 'budget_exceeded', runId: 'r1' },
    { slug: '11-ordinary', status: 'needs_review', verifierVerdict: 'transcript_errors', runId: 'r2' },
  ];
  const targets = selectAutoFixTargets(jobs, { fixSlugExists: () => false });
  assert.ok(!targets.some((t) => t.slug === '10-budget-victim'));
  assert.ok(targets.some((t) => t.slug === '11-ordinary'));
});
