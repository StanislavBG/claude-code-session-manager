/**
 * scheduler-inplace-salvage.test.cjs — PRD 1098: an in-place run (no
 * worktree — SM_JOB_WORKTREE_DISABLE=1 here, but the same finally-block path
 * also covers a non-git cwd, the worktree cap, or a carry-over failure) must
 * still salvage its uncommitted work, exactly like the worktree path already
 * did (gitWorktreeSalvage.test.cjs), and regardless of exit code. Drives
 * spawnJob end-to-end against a real git fixture repo with a stub `claude`
 * binary (SM_CLAUDE_BIN, same pattern as scheduler-worktree-exec-cwd.test.cjs)
 * that dirties the tree then exits 137 (SIGKILL), simulating a job killed
 * mid-run before its finish-protocol commit.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-inplace-salvage.test.cjs
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
let RUNS_DIR;

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

// readQueue()'s per-project discovery walks ~/.claude/projects/*/*.jsonl
// transcripts for a `cwd` field to find known project queue.json shards — an
// unregistered project's queue.json is invisible to mutate()/readQueue() and
// silently never gets written back to. Same helper scheduler-reap-dead-
// running-jobs.test.cjs uses.
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

// Stub `claude` binary: dirties the repo it runs in (a tracked-file edit and
// a brand-new untracked file — this job's own delta) then exits 137, with NO
// result:success event — simulating a job SIGKILLed mid-run before its
// finish-protocol commit. Deliberately emits no success result: scheduler.cjs
// maps a killed process straight back to exitCode 0 when it already saw
// result:success (the intentional "cleanup hung after real success" case),
// which is not the scenario under test here — this must land as a genuine
// non-zero exit.
function writeKilledClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-killed-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.cwd(), 'README.md'), 'hello\\nedited by job\\n', 'utf8');
    fs.writeFileSync(path.join(process.cwd(), 'job-output.txt'), 'work the job produced before dying\\n', 'utf8');
    process.exit(137);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inplace-salvage-'));
  process.env.HOME = tmpHome;
  originalDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  // Force the in-place path deterministically — this test is about the
  // salvage-on-every-exit-code behaviour, not about which condition
  // triggered the fallback (not-a-repo / cap / carry-over failure all land
  // in the same else branch).
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  ({ spawnJob, RUNS_DIR } = require('../scheduler.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalDisable === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalDisable;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
});

test('an in-place job killed (exit 137) mid-run salvages a delta-scoped patch that applies cleanly, without disturbing pre-existing WIP', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inplace-salvage-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  // Pre-existing human WIP untouched by the job — must survive completely
  // unmodified, and must never appear in the job's salvage patch.
  fs.writeFileSync(path.join(projectCwd, 'human-wip.txt'), 'human work in progress\n', 'utf8');
  git(['add', '-A'], projectCwd);
  // Leave it staged-but-uncommitted (real dirty WIP), not committed.
  fs.appendFileSync(path.join(projectCwd, 'human-wip.txt'), 'more human edits\n', 'utf8');

  const slug = `1098-test-inplace-killed-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do a thing that gets killed mid-run.', 'utf8');

  const queuePath = writeProjectQueue(projectCwd, [
    { slug, status: 'pending', cwd: projectCwd },
  ]);

  const statusBefore = git(['status', '--porcelain'], projectCwd);
  const stashBefore = git(['stash', 'list'], projectCwd);

  process.env.SM_CLAUDE_BIN = writeKilledClaudeStub();

  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);

    const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
    const row = jobs.find((j) => j.slug === slug);
    expect(row).toBeTruthy();
    expect(row.exitCode).toBe(137);
    expect(row.salvagePatch).toBeTruthy();
    expect(fs.existsSync(row.salvagePatch)).toBe(true);

    // Leftover-attribution fields: this job's own delta (README.md +
    // job-output.txt), never the human's pre-existing baseline WIP.
    expect(row.leftoverCount).toBe(2);
    expect(new Set(row.leftoverPaths)).toEqual(new Set(['README.md', 'job-output.txt']));
    // The pre-run baseline is cleared once the run has finalized — it was
    // only ever needed to compute the delta above.
    expect(row.guardBaseline).toBeUndefined();
    expect(row.guardHeadBefore).toBeUndefined();

    const patch = fs.readFileSync(row.salvagePatch, 'utf8');
    expect(patch).toContain('README.md');
    expect(patch).toContain('edited by job');
    expect(patch).toContain('job-output.txt');
    expect(patch).toContain('work the job produced before dying');
    // The human's pre-existing WIP (baseline-dirty, not part of this job's
    // delta) must never leak into the job's salvage patch.
    expect(patch).not.toContain('more human edits');

    // The patch must be self-sufficient and apply cleanly against a clean
    // checkout of the same base commit.
    const cleanCheckout = path.join(os.tmpdir(), `sm-inplace-salvage-clean-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
    git(['clone', '-q', projectCwd, cleanCheckout], os.tmpdir());
    try {
      expect(() => git(['apply', '--check', row.salvagePatch], cleanCheckout)).not.toThrow();
    } finally {
      fs.rmSync(cleanCheckout, { recursive: true, force: true });
    }

    // The shared tree itself was never mutated by the salvage pass — no
    // add/stash/reset/checkout/clean. (The job's own dirtying of README.md
    // and job-output.txt is real, expected, working-tree state left by the
    // stub process itself, not something salvage did — so we only assert no
    // stash was created and the human's pre-existing WIP file is untouched.)
    const stashAfter = git(['stash', 'list'], projectCwd);
    expect(stashAfter).toBe(stashBefore);
    const humanWipContent = fs.readFileSync(path.join(projectCwd, 'human-wip.txt'), 'utf8');
    expect(humanWipContent).toBe('human work in progress\nmore human edits\n');
    void statusBefore; // baseline captured for readability of intent above
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 30_000);

// Stub `claude` binary: touches nothing, emits a success result, and exits 0
// — a job whose only working-tree dirt is pre-existing human/sibling WIP
// present before the run even started.
function writeNoopClaudeStub() {
  const stubPath = path.join(os.tmpdir(), `sm-claude-stub-noop-${process.pid}-${Math.floor(Math.random() * 1e9)}.cjs`);
  const body = `
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'nothing to do', is_error: false }) + '\\n');
    process.exit(0);
  `;
  fs.writeFileSync(stubPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return stubPath;
}

test('a job whose tree is dirty only from pre-existing baseline WIP (human/sibling), and which itself dirties/commits nothing, gets no leftover attribution', async () => {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-inplace-salvage-project-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);

  // Pre-existing WIP present BEFORE the run — must never be attributed to
  // this job, even though it's still dirty at exit.
  fs.writeFileSync(path.join(projectCwd, 'human-wip.txt'), 'human work in progress\n', 'utf8');

  const slug = `1098-test-inplace-noop-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), 'Do nothing.', 'utf8');

  const queuePath = writeProjectQueue(projectCwd, [
    { slug, status: 'pending', cwd: projectCwd },
  ]);

  process.env.SM_CLAUDE_BIN = writeNoopClaudeStub();

  const runId = `run-${slug}`;
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    await spawnJob({ slug, cwd: projectCwd }, runId, runDir, projectCwd);

    const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
    const row = jobs.find((j) => j.slug === slug);
    expect(row).toBeTruthy();
    expect(row.exitCode).toBe(0);
    // No leftover attribution: the only dirt is baseline WIP, not this job's.
    expect(row.leftoverPaths).toBeUndefined();
    expect(row.leftoverCount).toBeUndefined();
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 30_000);
