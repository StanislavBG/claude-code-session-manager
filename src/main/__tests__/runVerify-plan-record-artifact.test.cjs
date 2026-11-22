// artifactsCheck: a session-manager-operations/plan-records/ artifact verifies
// only against the first root (queueEntry.cwd, the main checkout) — the
// scheduler harvests it there; a copy left only in the worktree never counts.
import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { artifactsVerifiedOnDisk } = require('../runVerify.cjs');

const RECORD = 'session-manager-operations/plan-records/abc123/plan.md';
const OTHER = 'docs/report.md';
let projectRoot;
let worktreeDir;

function write(root, rel, text = 'content\n') {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function check(paths) {
  const now = Date.now();
  return artifactsVerifiedOnDisk({
    cwd: [projectRoot, worktreeDir],
    paths,
    startedAt: new Date(now - 10_000).toISOString(),
    finishedAt: new Date(now).toISOString(),
  });
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-plan-root-'));
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-plan-wt-'));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

test('plan record present only in the worktree is not verified', { timeout: 10_000 }, () => {
  write(worktreeDir, RECORD);
  expect(check([RECORD])).toBe(false);
  expect(check([`./${RECORD}`])).toBe(false);
});

test('plan record present in the project root is verified', { timeout: 10_000 }, () => {
  write(projectRoot, RECORD);
  expect(check([RECORD])).toBe(true);
});

test('plan record with no main-checkout root is not verified even if the worktree has it', { timeout: 10_000 }, () => {
  write(worktreeDir, RECORD);
  const now = Date.now();
  expect(artifactsVerifiedOnDisk({
    cwd: [null, worktreeDir],
    paths: [RECORD],
    startedAt: new Date(now - 10_000).toISOString(),
    finishedAt: new Date(now).toISOString(),
  })).toBe(false);
});

test('non-plan-records artifact keeps the worktree fallback', { timeout: 10_000 }, () => {
  write(worktreeDir, OTHER);
  expect(check([OTHER])).toBe(true);
});
