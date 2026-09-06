/**
 * scheduler-leftover-quarantine.test.cjs — PRD 1128: once resume-first
 * recovery (PRD 1111) is spent and a job STILL parks needs_review with
 * 'uncommitted_changes', its recorded leftover paths must be quarantined off
 * the shared tree (onto a dedicated `sm-salvage/<slug>` ref) rather than left
 * dirty forever, poisoning every later worktree merge for that project (the
 * 216-jupiter-sand-kazekage incident, 2026-09-06).
 *
 * selectLeftoverQuarantineTarget is the pure eligibility rule (no I/O);
 * quarantineLeftovers is the git plumbing, exercised against a real
 * throwaway repo under os.tmpdir() (same pattern as gitWorktree.test.cjs).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-leftover-quarantine.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const scheduler = require('../scheduler.cjs');
const { selectLeftoverQuarantineTarget, quarantineLeftovers } = scheduler;

let tmpRoot;
let repoCwd;
let originalDisable;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'original c\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-leftover-quarantine-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
  originalDisable = process.env.SM_LEFTOVER_QUARANTINE_DISABLE;
  delete process.env.SM_LEFTOVER_QUARANTINE_DISABLE;
});

afterEach(() => {
  if (originalDisable === undefined) delete process.env.SM_LEFTOVER_QUARANTINE_DISABLE;
  else process.env.SM_LEFTOVER_QUARANTINE_DISABLE = originalDisable;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ──────────────────────────────────────────── selectLeftoverQuarantineTarget (pure)

function eligibleJob(overrides = {}) {
  return {
    slug: 'my-slug',
    cwd: repoCwd,
    status: 'needs_review',
    verifierVerdict: 'uncommitted_changes',
    resumeRecoveryAttempted: true,
    uncommittedPaths: ['a.txt', 'b.txt'],
    ...overrides,
  };
}

test('selectLeftoverQuarantineTarget: eligible job with no foreign WIP returns all uncommitted paths', () => {
  const target = selectLeftoverQuarantineTarget(eligibleJob());
  expect(target).toEqual({ slug: 'my-slug', cwd: repoCwd, paths: ['a.txt', 'b.txt'] });
});

test('selectLeftoverQuarantineTarget: a path present in preRunDirtyPaths (foreign WIP) is excluded', () => {
  const target = selectLeftoverQuarantineTarget(eligibleJob({ preRunDirtyPaths: ['a.txt'] }));
  expect(target).toEqual({ slug: 'my-slug', cwd: repoCwd, paths: ['b.txt'] });
});

test('selectLeftoverQuarantineTarget: every uncommitted path being foreign WIP returns null', () => {
  const target = selectLeftoverQuarantineTarget(eligibleJob({ preRunDirtyPaths: ['a.txt', 'b.txt'] }));
  expect(target).toBeNull();
});

test('selectLeftoverQuarantineTarget: not eligible unless resume recovery was already attempted', () => {
  expect(selectLeftoverQuarantineTarget(eligibleJob({ resumeRecoveryAttempted: false }))).toBeNull();
  expect(selectLeftoverQuarantineTarget(eligibleJob({ resumeRecoveryAttempted: undefined }))).toBeNull();
});

test('selectLeftoverQuarantineTarget: wrong status or verdict is ineligible', () => {
  expect(selectLeftoverQuarantineTarget(eligibleJob({ status: 'completed' }))).toBeNull();
  expect(selectLeftoverQuarantineTarget(eligibleJob({ verifierVerdict: 'transcript_errors' }))).toBeNull();
});

test('selectLeftoverQuarantineTarget: a second call is a no-op once leftoverQuarantineAttempted is true', () => {
  const job = eligibleJob();
  expect(selectLeftoverQuarantineTarget(job)).not.toBeNull();
  job.leftoverQuarantineAttempted = true;
  expect(selectLeftoverQuarantineTarget(job)).toBeNull();
});

test('selectLeftoverQuarantineTarget: kill-switch SM_LEFTOVER_QUARANTINE_DISABLE=1 always returns null', () => {
  process.env.SM_LEFTOVER_QUARANTINE_DISABLE = '1';
  expect(selectLeftoverQuarantineTarget(eligibleJob())).toBeNull();
});

// ──────────────────────────────────────────── quarantineLeftovers (real git plumbing)

test('quarantineLeftovers: commits leftovers onto sm-salvage/<slug> and restores the tree to baseline', async () => {
  const baseline = git(['rev-parse', 'HEAD'], repoCwd).trim();
  fs.writeFileSync(path.join(repoCwd, 'a.txt'), 'modified a\n', 'utf8');
  fs.writeFileSync(path.join(repoCwd, 'b.txt'), 'new file b\n', 'utf8');

  const result = await quarantineLeftovers({ cwd: repoCwd, slug: 'my-slug', paths: ['a.txt', 'b.txt'], headBefore: baseline });

  expect(result.ok).toBe(true);
  expect(result.ref).toBe('sm-salvage/my-slug');
  expect(result.commit).toBeTruthy();
  expect(result.quarantinedPaths.sort()).toEqual(['a.txt', 'b.txt']);

  // The checked-out branch never moved.
  expect(git(['rev-parse', 'HEAD'], repoCwd).trim()).toBe(baseline);
  // The salvage ref's parent is the baseline commit.
  expect(git(['rev-parse', `${result.ref}^`], repoCwd).trim()).toBe(baseline);
  // The salvage commit carries the leftover content.
  expect(git(['show', `${result.ref}:a.txt`], repoCwd)).toBe('modified a\n');
  expect(git(['show', `${result.ref}:b.txt`], repoCwd)).toBe('new file b\n');

  // The working tree is restored to the pre-run baseline.
  expect(fs.readFileSync(path.join(repoCwd, 'a.txt'), 'utf8')).toBe('original a\n');
  expect(fs.existsSync(path.join(repoCwd, 'b.txt'))).toBe(false);
  expect(git(['status', '--porcelain'], repoCwd).trim()).toBe('');
});

test('quarantineLeftovers: a path dirty at dispatch time (foreign WIP, filtered out by the caller) is left exactly as-is', async () => {
  const baseline = git(['rev-parse', 'HEAD'], repoCwd).trim();
  fs.writeFileSync(path.join(repoCwd, 'a.txt'), 'modified a\n', 'utf8');
  fs.writeFileSync(path.join(repoCwd, 'c.txt'), 'someone elses edit\n', 'utf8');

  // Simulate the caller having already excluded 'c.txt' via preRunDirtyPaths
  // by never passing it in `paths`.
  const result = await quarantineLeftovers({ cwd: repoCwd, slug: 'my-slug', paths: ['a.txt'], headBefore: baseline });

  expect(result.ok).toBe(true);
  expect(result.quarantinedPaths).toEqual(['a.txt']);
  // The foreign path is completely untouched.
  expect(fs.readFileSync(path.join(repoCwd, 'c.txt'), 'utf8')).toBe('someone elses edit\n');
  expect(git(['status', '--porcelain', '--', 'c.txt'], repoCwd).trim()).not.toBe('');
});

test('quarantineLeftovers: a path no longer dirty on disk is skipped, not force-restored', async () => {
  const baseline = git(['rev-parse', 'HEAD'], repoCwd).trim();
  fs.writeFileSync(path.join(repoCwd, 'a.txt'), 'modified a\n', 'utf8');
  fs.writeFileSync(path.join(repoCwd, 'b.txt'), 'new file b\n', 'utf8');
  // a.txt gets committed by something else between parking and quarantine —
  // it is no longer dirty relative to the live tree.
  git(['add', 'a.txt'], repoCwd);
  git(['commit', '-q', '-m', 'a.txt landed separately'], repoCwd);

  const result = await quarantineLeftovers({ cwd: repoCwd, slug: 'my-slug', paths: ['a.txt', 'b.txt'], headBefore: baseline });

  expect(result.ok).toBe(true);
  expect(result.quarantinedPaths).toEqual(['b.txt']);
  expect(result.skippedPaths).toEqual(['a.txt']);
  // a.txt was never touched — still whatever the later commit left it as.
  expect(fs.readFileSync(path.join(repoCwd, 'a.txt'), 'utf8')).toBe('modified a\n');
  expect(fs.existsSync(path.join(repoCwd, 'b.txt'))).toBe(false);
});

test('quarantineLeftovers: a git command failure abandons the whole attempt with the tree untouched', async () => {
  fs.writeFileSync(path.join(repoCwd, 'a.txt'), 'modified a\n', 'utf8');

  const result = await quarantineLeftovers({
    cwd: repoCwd,
    slug: 'my-slug',
    paths: ['a.txt'],
    headBefore: '0000000000000000000000000000000000000000', // never resolvable
  });

  expect(result.ok).toBe(false);
  expect(result.reason).toBeTruthy();
  // Nothing was quarantined or restored.
  expect(fs.readFileSync(path.join(repoCwd, 'a.txt'), 'utf8')).toBe('modified a\n');
  expect(git(['status', '--porcelain'], repoCwd).trim()).not.toBe('');
  expect(() => git(['rev-parse', '--verify', 'refs/heads/sm-salvage/my-slug'], repoCwd)).toThrow();
});

test('quarantineLeftovers: a non-git cwd is abandoned cleanly with a reason', async () => {
  const notARepo = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(notARepo, { recursive: true });
  fs.writeFileSync(path.join(notARepo, 'a.txt'), 'x\n', 'utf8');

  const result = await quarantineLeftovers({ cwd: notARepo, slug: 'my-slug', paths: ['a.txt'] });
  expect(result.ok).toBe(false);
  expect(result.reason).toBeTruthy();
});
