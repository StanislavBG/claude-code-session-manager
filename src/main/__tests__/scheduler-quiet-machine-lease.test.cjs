/**
 * scheduler-quiet-machine-lease.test.cjs — PRD 1107: the exclusive
 * quiet-machine lease must be released on EVERY spawnJob exit path,
 * including a killed job (SIGKILL/exit 137), not just a clean exit — the
 * same finally block that already releases the sessionSlots token. Drives
 * spawnJob end-to-end against a real git fixture repo with a stub `claude`
 * binary that exits 137 mid-run (same pattern as
 * scheduler-inplace-salvage.test.cjs), then asserts:
 *   1. the lease is released once the job settles, and
 *   2. an ordinary pending job — held behind the lease while it was held —
 *      is now eligible to dispatch.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-quiet-machine-lease.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let tmpHome;
let originalHome;
let originalDisable;
let spawnJob;
let quietMachineLease;
let pickNextBatch;

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

// See scheduler-inplace-salvage.test.cjs's identical helper: readQueue()'s
// per-project discovery walks ~/.claude/projects/*/*.jsonl transcripts for a
// `cwd` field to find known project queue.json shards.
function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

// Stub `claude` binary that exits 137 (SIGKILL) with no result:success event,
// simulating a leased job killed mid-run before it could finish and release
// naturally through its own clean-exit path. Dirties the tree first (like
// scheduler-inplace-salvage.test.cjs's stub) so the scheduler classifies this
// as a genuine kill-with-partial-work, not an auto-retryable transient blip
// with no evidence of real execution.
function writeKilledClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-quiet-killed-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'job-output.txt'), 'work in progress when killed\\n', 'utf8');
    process.exit(137);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-quiet-lease-'));
  process.env.HOME = tmpHome;
  originalDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  ({ spawnJob } = require('../scheduler.cjs'));
  ({ pickNextBatch } = require('../lib/schedulerBatch.cjs'));
  quietMachineLease = require('../lib/quietMachineLease.cjs');
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalDisable === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalDisable;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  quietMachineLease.__resetForTests();
});

test('a killed quietMachine job releases the exclusive lease, and an ordinary job dispatches on the next pick', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-quiet-lease-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  const quietSlug = `1107-test-quiet-killed-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const ordinarySlug = `1107-test-ordinary-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${quietSlug}.md`), '---\nquietMachine: true\n---\nMeasure timing without contention, then get killed.', 'utf8');
  fs.writeFileSync(path.join(prdsDir, `${ordinarySlug}.md`), 'An ordinary PRD queued behind the quiet job.', 'utf8');

  const queuePath = writeProjectQueue(projectCwd, [
    { slug: quietSlug, status: 'pending', cwd: projectCwd, quietMachine: true },
    { slug: ordinarySlug, status: 'pending', cwd: projectCwd, createdAt: new Date().toISOString() },
  ]);

  process.env.SM_CLAUDE_BIN = writeKilledClaudeStub();

  const runId = `run-${quietSlug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    // Before spawnJob ever runs, demonstrate that a held lease (as it would
    // be while quietSlug is genuinely running) blocks EVERY dispatch,
    // including the ordinary sibling job sitting right behind it in the same
    // project. Uses a standalone dummy holder so it doesn't interact with
    // spawnJob's own acquire/release of the real lease below.
    expect(quietMachineLease.acquire('dummy-holder-simulating-in-flight-run')).toBe(true);
    const heldPick = pickNextBatch(
      [
        { slug: quietSlug, status: 'running', cwd: projectCwd, quietMachine: true },
        { slug: ordinarySlug, status: 'pending', cwd: projectCwd, createdAt: new Date().toISOString() },
      ],
      new Set([quietSlug]),
      5,
      { leaseHeld: quietMachineLease.isHeld(), machineInUse: 1, now: Date.now() },
    );
    expect(heldPick.batch).toEqual([]);
    quietMachineLease.release('dummy-holder-simulating-in-flight-run');

    // Now the real thing: spawnJob acquires the lease itself for quietSlug,
    // runs the killed stub, and must release it on this exit path.
    await spawnJob({ slug: quietSlug, cwd: projectCwd, quietMachine: true }, runId, runDir, projectCwd);

    const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
    const quietRow = jobs.find((j) => j.slug === quietSlug);
    expect(quietRow).toBeTruthy();
    expect(quietRow.exitCode).toBe(137);
    expect(quietRow.quietMachine).toBe(true);

    // The lease was released on this killed-job exit path — spawnJob's own
    // finally block, the same one that releases the sessionSlots token.
    expect(quietMachineLease.isHeld()).toBe(false);

    // With the lease free again, the ordinary sibling job is now eligible.
    const nextPick = pickNextBatch(
      [
        { slug: quietSlug, status: 'failed', cwd: projectCwd, quietMachine: true },
        { slug: ordinarySlug, status: 'pending', cwd: projectCwd, createdAt: new Date().toISOString() },
      ],
      new Set(),
      5,
      { leaseHeld: quietMachineLease.isHeld(), machineInUse: 0, now: Date.now() },
    );
    expect(nextPick.batch.map((j) => j.slug)).toEqual([ordinarySlug]);
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 30_000);
