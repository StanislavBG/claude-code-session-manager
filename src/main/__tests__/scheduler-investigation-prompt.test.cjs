/**
 * scheduler-investigation-prompt.test.cjs — unit tests for buildInvestigationPrompt.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-investigation-prompt.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildInvestigationPrompt, isGitRepoSync } = require('../scheduler.cjs');

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

// ─── cwd-must-be-git-repo-root guidance (99-fix-e2e-needs-review-test) ────────

test('prompt instructs that cwd must be the git repo root where the fix will land', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  assert.match(prompt, /cwd.*must be the git repo root/);
  assert.match(prompt, /needs_review/);
});

test('prompt frontmatter block still declares exactly the four expected keys', () => {
  const prompt = buildInvestigationPrompt(makeArgs());
  const fenceMatch = prompt.match(/```\s*\n\s*---\n([\s\S]*?)\n\s*---\n\s*```/);
  assert.ok(fenceMatch, 'expected a fenced frontmatter block in the prompt');
  const keys = fenceMatch[1]
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(':')[0].trim());
  assert.deepEqual(keys, ['title', 'cwd', 'parallelGroup', 'estimateMinutes']);
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
