/**
 * scheduler-investigation-prompt.test.cjs — unit tests for buildInvestigationPrompt.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-investigation-prompt.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildInvestigationPrompt } = require('../scheduler.cjs');
const { isGitRepoSync } = require('../scheduler/gitTreeGuard.cjs');

function makeArgs(overrides = {}) {
  return {
    failedJob: { slug: '05-my-feature', title: 'My feature', exitCode: 1 },
    cwd: '/home/bilko/Projects/session-manager',
    failedLogPath: '/tmp/05-my-feature.log',
    originalBody: 'Original PRD body.',
    logTail: 'some log tail output',
    fixPath: '/tmp/05-fix-my-feature.md',
    group: 5,
    ...overrides,
  };
}

test('prompt references the canonical standards.md file', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /standards\.md/);
  assert.match(prompt, /plugins\/session-manager-dev\/skills\/develop\/standards\.md/);
});

test('prompt instructs inlining the Execution discipline section under Engineering standards', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /Engineering standards/);
  assert.match(prompt, /Execution discipline \(headless runs\)/);
});

test('prompt contains the named "delegated instead of executed" detection check', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /ScheduleWakeup/);
  assert.match(prompt, /session-manager-dev:develop/);
  assert.match(prompt, /never re-queue or self-schedule|delegated instead of executed/);
});

test('prompt includes the resolved job fields', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /05-my-feature/);
  assert.match(prompt, /Original PRD body\./);
  assert.match(prompt, /some log tail output/);
  assert.match(prompt, /05-fix-my-feature\.md/);
});

// ─── abandoned_background_task: investigation prompt directs a commit-first check ─

test('prompt for an abandoned_background_task job directs inspecting the working tree and committing before re-implementing', () => {
  const prompt = buildInvestigationPrompt(makeArgs({
    failedJob: { slug: '05-my-feature', title: 'My feature', exitCode: 0, verifierVerdict: 'abandoned_background_task' },
  }));
  assert.match(prompt, /abandoned_background_task/);
  assert.match(prompt, /git status/);
  assert.match(prompt, /COMMIT/);
  assert.match(prompt, /not re-implement or re-plan the PRD from scratch/);
});

test('prompt for a job with no abandoned_background_task verdict omits the note', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.doesNotMatch(prompt, /abandoned_background_task/);
});

test('prompt for an abandoned_background_task job with a salvage patch names its exact path', () => {
  const prompt = buildInvestigationPrompt(makeArgs({
    failedJob: {
      slug: '05-my-feature',
      title: 'My feature',
      exitCode: 0,
      verifierVerdict: 'abandoned_background_task',
      salvagePatch: '/tmp/runs/2026-09-02/05-my-feature.uncommitted.patch',
    },
  }));
  assert.match(prompt, /05-my-feature\.uncommitted\.patch/);
  assert.match(prompt, /apply it to the working tree BEFORE inspecting/);
});

// ─── run_commit_not_landed: investigation re-lands the pinned commit ───────────

test('prompt for a run_commit_not_landed job directs cherry-picking the pinned commits first', () => {
  const prompt = buildInvestigationPrompt(makeArgs({
    failedJob: { slug: '05-my-feature', title: 'My feature', exitCode: 0, verifierVerdict: 'run_commit_not_landed' },
  }));
  assert.match(prompt, /Known failure class: run_commit_not_landed/);
  assert.match(prompt, /git -C \/home\/bilko\/Projects\/session-manager for-each-ref refs\/sm-stranded\/05-my-feature\//);
  assert.match(prompt, /cherry-pick/);
  assert.match(prompt, /oldest first/);
  assert.match(prompt, /re-implement only/);
  assert.match(prompt, /failure log names the SHA/);
});

test('prompt for a job with another verdict omits the run_commit_not_landed note', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.doesNotMatch(prompt, /run_commit_not_landed/);
  const other = buildInvestigationPrompt(makeArgs({
    failedJob: { slug: '05-my-feature', title: 'My feature', exitCode: 0, verifierVerdict: 'abandoned_background_task' },
  }));
  assert.doesNotMatch(other, /run_commit_not_landed/);
});

// ─── cwd-must-be-git-repo-root guidance (99-fix-e2e-needs-review-test) ────────

test('prompt instructs that cwd must be the git repo root where the fix will land', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /cwd.*must be the git repo root/);
  assert.match(prompt, /needs_review/);
});

test('prompt frontmatter block still declares exactly the five expected keys', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  const fenceMatch = prompt.match(/```\s*\n\s*---\n([\s\S]*?)\n\s*---\n\s*```/);
  assert.ok(fenceMatch, 'expected a fenced frontmatter block in the prompt');
  const keys = fenceMatch[1]
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(':')[0].trim());
  assert.deepEqual(keys, ['title', 'cwd', 'parallelGroup', 'estimateMinutes', 'isFixPlan']);
});

// ─── isGitRepoSync (scheduler.cjs) ─────────────────────────────────────────────

test('isGitRepoSync: true for a real git repo, false for a non-repo dir, false for missing/undefined', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-isgitrepo-repo-'));
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-isgitrepo-plain-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    assert.equal(isGitRepoSync(repo), true);
    assert.equal(isGitRepoSync(nonRepo), false);
    assert.equal(isGitRepoSync(undefined), false);
    assert.equal(isGitRepoSync(''), false);
    assert.equal(isGitRepoSync('/definitely/does/not/exist'), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(nonRepo, { recursive: true, force: true });
  }
});

// ─── Records and commits: the one allowed record path (PRD 2883) ─────────────

const { fixPlanRecordPath } = require('../lib/scheduler/fixPlanSlug.cjs');
const { RUNTIME_NAMESPACES } = require('../lib/opsOwnership.cjs');

const RECORD_BAN_MARKER = 'Never name any of these paths as a file to write or commit';

function promptVariants() {
  const recordPath = fixPlanRecordPath('e1', '1695-fix-x');
  return [
    buildInvestigationPrompt(makeArgs()),
    buildInvestigationPrompt(makeArgs({ recordPath, recordIgnored: false })),
    buildInvestigationPrompt(makeArgs({ recordPath, recordIgnored: true })),
    buildInvestigationPrompt(makeArgs({
      recordPath, recordIgnored: false,
      failedJob: { slug: '05-my-feature', title: 'My feature', exitCode: 1, verifierVerdict: 'abandoned_background_task' },
    })),
  ];
}

test('fixPlanRecordPath: epic-scoped for a safe epicId, flat for missing/unsafe, never under scheduler/', () => {
  assert.equal(fixPlanRecordPath('e1', '1695-fix-x'), 'session-manager-operations/reviews/validation/e1/1695-fix-x.md');
  for (const bad of [undefined, null, '', '../x', 'a/b', 'a\\b']) {
    const p = fixPlanRecordPath(bad, '1695-fix-x');
    assert.equal(p, 'session-manager-operations/reviews/validation/1695-fix-x.md');
    assert.doesNotMatch(p, /session-manager-operations\/scheduler\//);
  }
});

test('recordIgnored false names the exact record path and plain git add', () => {
  const prompt = buildInvestigationPrompt(makeArgs({ recordPath: fixPlanRecordPath('e1', '1695-fix-x'), recordIgnored: false }));
  assert.ok(prompt.includes('session-manager-operations/reviews/validation/e1/1695-fix-x.md'));
  assert.ok(prompt.includes('git add session-manager-operations/reviews/validation/e1/1695-fix-x.md'));
  assert.match(prompt, /only allowed record location/);
});

test('recordIgnored true (and the defaults) name no record path and forbid asking for a record', () => {
  const ignored = buildInvestigationPrompt(makeArgs({ recordPath: fixPlanRecordPath('e1', '1695-fix-x'), recordIgnored: true }));
  assert.match(ignored, /ignores/);
  assert.match(ignored, /must not ask for any record file/);
  assert.doesNotMatch(ignored, /reviews\/validation\/e1\/1695-fix-x\.md/);
  const dflt = buildInvestigationPrompt(makeArgs());
  assert.match(dflt, /must not ask for any record file/);
  assert.doesNotMatch(dflt, /reviews\/validation\//);
});

test('every variant states the no-change fix plan makes no commit and closes on a truthful PASS', () => {
  for (const prompt of promptVariants()) {
    assert.match(prompt, /only confirms already-landed work changes no file and makes no commit/);
    assert.match(prompt, /SCHEDULER_VERDICT: PASS with no commit/);
    assert.match(prompt, /never add a record just so the job can close/);
  }
});

test('every variant bans every runtime namespace path and force-adds', () => {
  for (const prompt of promptVariants()) {
    for (const ns of RUNTIME_NAMESPACES) assert.ok(prompt.includes(`session-manager-operations/${ns}/`), ns);
    assert.ok(prompt.includes(RECORD_BAN_MARKER));
    assert.match(prompt, /git add -f/);
    assert.match(prompt, /git add --force/);
  }
});

test('apart from fixPath and the ban line, no variant points a write at session-manager-operations/scheduler/', () => {
  const fixPath = '/repo/session-manager-operations/scheduler/epics/e1/prds/1695-fix-x.md';
  const recordPath = fixPlanRecordPath('e1', '1695-fix-x');
  for (const extra of [{}, { recordPath, recordIgnored: false }, { recordPath, recordIgnored: true }]) {
    const prompt = buildInvestigationPrompt(makeArgs({ fixPath, ...extra }));
    const rest = prompt.split(fixPath).join('<FIX_PATH>')
      .split('\n').filter((l) => !l.includes(RECORD_BAN_MARKER)).join('\n');
    assert.doesNotMatch(rest, /session-manager-operations\/scheduler\//);
  }
});
