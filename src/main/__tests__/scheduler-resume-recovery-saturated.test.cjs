/**
 * scheduler-resume-recovery-saturated.test.cjs — the periodic resume-recovery
 * pass (reverifyNeedsReview) starts ONE `--resume` run on a saturated CPU and
 * every eligible row otherwise.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-resume-recovery-saturated.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');
const { settleScheduler } = require('../../../tests/helpers/schedulerSettle.cjs');

const PRD_BODY = '---\ntitle: Resume PRD\ncreatedVia: scheduler-api\n---\n\nResume PRD.\n';

let tmpHome;
let originalHome;
let originalWt;
let scheduler;
let createLoadGate;
let queueStore;
let holdGate;

function gateWithCpu(busyFraction) {
  return createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction, iowaitFraction: 0, windowMs: 61_000 }) },
  });
}

function makeProject(name) {
  const cwd = path.join(tmpHome, 'Projects', name);
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'fixture-epic', 'prds');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(prdsDir, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${name}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  return { cwd, prdsDir, queueFile: path.join(stateDir, 'queue.json') };
}

function attemptedCount(proj) {
  try {
    return JSON.parse(fs.readFileSync(proj.queueFile, 'utf8')).jobs.filter((j) => j.resumeRecoveryAttempted === true).length;
  } catch { return 0; }
}

async function runPass(name, gate, expected) {
  const proj = makeProject(name);
  const slugs = ['a', 'b', 'c'].map((x) => `9401-${name}-${x}`);
  for (const slug of slugs) fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: slugs.map((slug, i) => ({
      slug, title: slug, status: 'needs_review', cwd: proj.cwd, dependsOn: [],
      createdAt: new Date().toISOString(),
      verifierVerdict: 'uncommitted_changes',
      runId: `run-${name}-${i}`,
      sessionId: `sess-${name}-${i}`,
      uncommittedPaths: ['src/foo.js'],
    })),
  }));
  queueStore.bustCwdCache();
  scheduler._setLoadGateForTests(gate);
  await scheduler.reverifyNeedsReview();
  let n = 0;
  for (let i = 0; i < 100; i += 1) {
    n = attemptedCount(proj);
    if (n >= expected) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Give a wrongly-launched extra row time to show up.
  await new Promise((r) => setTimeout(r, 300));
  return attemptedCount(proj);
}

beforeAll(() => {
  originalHome = process.env.HOME;
  originalWt = process.env.SM_JOB_WORKTREE_DISABLE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-resume-sat-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  ({ createLoadGate } = require('../lib/scheduler/loadGate.cjs'));
  queueStore = require('../lib/scheduler/queueStore.cjs');
  holdGate = gateWithCpu(0.95);
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n');
    process.exit(0);
  ` });
});

afterEach(() => settleScheduler({ scheduler, holdGate, projectsDir: path.join(tmpHome, 'Projects') }));

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  process.env.HOME = originalHome;
  if (originalWt === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalWt;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_BIN;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('saturated CPU (0.95 busy): a pass starts exactly one resume recovery', async () => {
  expect(await runPass('sat', gateWithCpu(0.95), 1)).toBe(1);
}, 60_000);

test('idle CPU (0.13 busy): a pass starts all three resume recoveries', async () => {
  expect(await runPass('idle', gateWithCpu(0.13), 3)).toBe(3);
}, 60_000);
