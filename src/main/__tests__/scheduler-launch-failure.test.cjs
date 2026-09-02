/**
 * scheduler-launch-failure.test.cjs — issue #11 end to end at the executeJob
 * + handleLaunchFailure level with a stub `claude` that reproduces the
 * macOS incident verbatim: HTTP 400 `thinking.type.enabled` on the first
 * request, one turn, zero output tokens, exit 1 in seconds.
 *
 * Proves: the run is classified as a launch failure (not a PRD failure), the
 * API message lands on the row, the row goes back to `pending` (never
 * `failed`), the persona's launch breaker is armed in the machine state, the
 * outcome sidecar is written, the child env carries the headless-job marker
 * and the mitigation env, and a stub that then takes a real turn is NOT a
 * launch failure.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-launch-failure.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let executeJob;
let handleLaunchFailure;
let applyLaunchFailure;
let writeQueue;
let queueStore;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-launch-failure-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  ({ executeJob, handleLaunchFailure, applyLaunchFailure, writeQueue } = require('../scheduler.cjs'));
  queueStore = require('../lib/queueStore.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

const THINKING_400 = 'API Error: 400 {"detail":{"error":"{\\"message\\":\\"\\\\\\"thinking.type.enabled\\\\\\" is not supported for this model. Use \\\\\\"thinking.type.adaptive\\\\\\" and \\\\\\"output_config.effort\\\\\\" to control thinking behavior.\\"}"}}';

function writeStub({ mode }) {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-launch-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'env.marker'), JSON.stringify({
      SM_SCHEDULER_JOB_SLUG: process.env.SM_SCHEDULER_JOB_SLUG || null,
      SM_SCHEDULER_JOB_MAY_QUEUE: process.env.SM_SCHEDULER_JOB_MAY_QUEUE || null,
      MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || null,
    }), 'utf8');
    const mode = ${JSON.stringify(mode)};
    if (mode === 'thinking-400') {
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: ${JSON.stringify(THINKING_400)} }] } }) + '\\n');
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error_status: 400, num_turns: 1, duration_ms: 2000, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, result: ${JSON.stringify(THINKING_400)} }) + '\\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, num_turns: 9, usage: { input_tokens: 100, output_tokens: 250 }, result: 'Error: tests failed' }) + '\\n');
    process.exit(1);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

function mkProject() {
  const mainCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-launch-main-'));
  const slug = `1201-launch-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(mainCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do the thing.', 'utf8');
  const runDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'sm-launch-run-'));
  return { mainCwd, slug, runDir };
}

test('executeJob: the issue-#11 400 is a launch failure with the API message, and meta.json records it', async () => {
  const { mainCwd, slug, runDir } = mkProject();
  process.env.SM_CLAUDE_BIN = writeStub({ mode: 'thinking-400' });
  const job = { slug, cwd: mainCwd, agentType: 'dev-lead' };

  const res = await executeJob(job, runDir, mainCwd, () => Promise.resolve(), undefined, null, null, { MAX_THINKING_TOKENS: '0' });

  expect(res.exitCode).toBe(1);
  expect(res.launchFailure).toMatchObject({ kind: 'model_config_rejected', httpStatus: 400 });
  expect(res.launchFailure.message).toMatch(/thinking\.type\.enabled.*not supported/);
  expect(res.resultStats).toMatchObject({ numTurns: 1, outputTokens: 0 });

  const meta = JSON.parse(fs.readFileSync(path.join(runDir, `${slug}.meta.json`), 'utf8'));
  expect(meta.launchFailure.kind).toBe('model_config_rejected');
  expect(meta.numTurns).toBe(1);
  expect(meta.outputTokens).toBe(0);
  expect(meta.launchEnvApplied).toEqual(['MAX_THINKING_TOKENS']);

  const env = JSON.parse(fs.readFileSync(path.join(mainCwd, 'env.marker'), 'utf8'));
  expect(env.SM_SCHEDULER_JOB_SLUG).toBe(slug);
  expect(env.SM_SCHEDULER_JOB_MAY_QUEUE).toBe('0');
  expect(env.MAX_THINKING_TOKENS).toBe('0');

  const log = fs.readFileSync(path.join(runDir, `${slug}.log`), 'utf8');
  expect(log).toMatch(/LAUNCH FAILURE \(model_config_rejected HTTP 400\)/);
  expect(log).toMatch(/launch mitigation env applied: MAX_THINKING_TOKENS=0/);

  fs.rmSync(mainCwd, { recursive: true, force: true });
});

test('executeJob: a run that took real turns and failed is NOT a launch failure; architect persona may queue', async () => {
  const { mainCwd, slug, runDir } = mkProject();
  process.env.SM_CLAUDE_BIN = writeStub({ mode: 'real-failure' });
  const job = { slug, cwd: mainCwd, agentType: 'architect' };

  const res = await executeJob(job, runDir, mainCwd, () => Promise.resolve());

  expect(res.exitCode).toBe(1);
  expect(res.launchFailure).toBeNull();
  expect(res.resultStats).toMatchObject({ numTurns: 9, outputTokens: 250 });
  const env = JSON.parse(fs.readFileSync(path.join(mainCwd, 'env.marker'), 'utf8'));
  expect(env.SM_SCHEDULER_JOB_MAY_QUEUE).toBe('1');
  expect(env.MAX_THINKING_TOKENS).toBeNull();

  fs.rmSync(mainCwd, { recursive: true, force: true });
});

test('applyLaunchFailure: row → pending with the API message, breaker armed, never failed; a repeat escalates the same block', () => {
  const runId = '2026-09-02T17-54-14-770Z';
  const job = { slug: '1201-a', cwd: '/tmp/p', agentType: 'dev-lead', status: 'running', runId, startedAt: '2026-09-02T17:54:14.770Z', statusHistory: [] };
  const s = { jobs: [job], launchBlocks: {}, launchMitigations: { 'dev-lead': { env: { MAX_THINKING_TOKENS: '0' } } } };
  const lf = { kind: 'model_config_rejected', httpStatus: 400, message: '"thinking.type.enabled" is not supported for this model.' };
  const T0 = Date.parse('2026-09-02T18:00:00Z');

  const armed = applyLaunchFailure(s, { job, lf, runId, launchKey: 'dev-lead', mitigationApplied: false, claudeVersion: '1.0.90', now: T0 });

  expect(armed.kind).toBe('model_config_rejected');
  expect(armed.attempts).toBe(1);
  expect(s.launchBlocks['dev-lead']).toBe(armed);
  expect(s.launchMitigations['dev-lead']).toBeTruthy(); // not dropped: no mitigation was applied to THIS run

  const row = s.jobs[0];
  expect(row.status).toBe('pending');
  expect(row.error).toMatch(/launch failure \(model_config_rejected HTTP 400\): "thinking\.type\.enabled"/);
  expect(row.launchFailure).toMatchObject({ kind: 'model_config_rejected', httpStatus: 400, count: 1, runId, mitigationApplied: false });
  expect(row.terminalReason).toBe('launch_failure:model_config_rejected');
  expect(row.heldReason).toMatch(/^launch blocked \(model_config_rejected\)/);
  expect(row.transientRetries ?? 0).toBe(0);
  expect(row.autoFixOutcome).toBeUndefined();
  expect(row.runId).toBeNull();

  // Second identical failure, this time WITH the mitigation applied → same
  // block escalates, the unproven mitigation is dropped, the hint is honest.
  row.status = 'running';
  const armed2 = applyLaunchFailure(s, { job: row, lf, runId, launchKey: 'dev-lead', mitigationApplied: true, claudeVersion: '1.0.90', now: T0 + 1000 });
  expect(armed2.attempts).toBe(2);
  expect(armed2.mitigationApplied).toBe(true);
  expect(armed2.hint).toMatch(/did not get past it/);
  expect(Date.parse(armed2.until)).toBeGreaterThan(Date.parse(armed.until));
  expect(s.launchMitigations['dev-lead']).toBeUndefined();
  expect(row.launchFailure.count).toBe(2);
  expect(row.status).toBe('pending');
});

test('applyLaunchFailure: a row already finalized by someone else (cancel) is left alone, breaker still arms', () => {
  const job = { slug: '1201-b', agentType: 'dev-lead', status: 'failed', error: 'cancelled via admin API' };
  const s = { jobs: [job], launchBlocks: {}, launchMitigations: {} };
  applyLaunchFailure(s, { job, lf: { kind: 'auth_failed', httpStatus: 401, message: 'bad key' }, runId: 'r', launchKey: 'dev-lead', mitigationApplied: false, claudeVersion: null, now: Date.now() });
  expect(s.jobs[0].status).toBe('failed');
  expect(s.jobs[0].error).toBe('cancelled via admin API');
  expect(s.launchBlocks['dev-lead'].kind).toBe('auth_failed');
});

test('handleLaunchFailure: persists the breaker into the machine state file and writes the outcome sidecar', async () => {
  const { mainCwd, slug, runDir } = mkProject();
  const runId = path.basename(runDir);
  const job = { slug, cwd: mainCwd, agentType: 'dev-lead', status: 'running', runId };
  await writeQueue({ config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null, launchBlocks: {}, launchMitigations: {} });

  const res = {
    exitCode: 1, durationMs: 2000,
    launchFailure: { kind: 'model_config_rejected', httpStatus: 400, message: '"thinking.type.enabled" is not supported for this model.' },
    resultStats: { numTurns: 1, outputTokens: 0, totalCostUsd: 0 },
  };
  await handleLaunchFailure({ job, res, runId, runDir, launchKey: 'dev-lead', launchEnv: null, claudeVersion: '1.0.90' });

  const machine = JSON.parse(fs.readFileSync(queueStore.MACHINE_STATE_PATH, 'utf8'));
  const block = machine.launchBlocks['dev-lead'];
  expect(block).toMatchObject({ kind: 'model_config_rejected', attempts: 1, claudeVersion: '1.0.90', lastSlug: slug, mitigationEnv: { MAX_THINKING_TOKENS: '0' } });
  expect(block.hint).toMatch(/claude update/);

  const outcome = JSON.parse(fs.readFileSync(path.join(runDir, `${slug}.outcome.json`), 'utf8'));
  expect(outcome).toMatchObject({ slug, runId, numTurns: 1, outputTokens: 0, status: 'pending', terminalReason: 'launch_failure:model_config_rejected' });
  expect(outcome.launchFailure.kind).toBe('model_config_rejected');

  fs.rmSync(mainCwd, { recursive: true, force: true });
});
