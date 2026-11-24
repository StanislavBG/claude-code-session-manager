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

// ─── directory artifacts (trailing-slash plan-records folder) ───────────────

const RECORD_DIR = 'session-manager-operations/plan-records/abc123/';
const OTHER_DIR = 'docs/out/';

function setAge(root, rel, ageMs) {
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(root, rel), t, t);
}

test('plan-records directory with a fresh child in the main root is verified', { timeout: 10_000 }, () => {
  write(projectRoot, `${RECORD_DIR}validate.md`);
  expect(check([RECORD_DIR])).toBe(true);
});

test('plan-records directory whose child exists only in the worktree is not verified', { timeout: 10_000 }, () => {
  write(worktreeDir, `${RECORD_DIR}validate.md`);
  expect(check([RECORD_DIR])).toBe(false);
});

test('directory whose only child is stale is not verified', { timeout: 10_000 }, () => {
  write(projectRoot, `${RECORD_DIR}validate.md`);
  setAge(projectRoot, `${RECORD_DIR}validate.md`, 3_600_000);
  expect(check([RECORD_DIR])).toBe(false);
});

test('directory with only an empty child, or no files, is not verified', { timeout: 10_000 }, () => {
  write(projectRoot, `${RECORD_DIR}empty.md`, '');
  expect(check([RECORD_DIR])).toBe(false);
  fs.rmSync(path.join(projectRoot, RECORD_DIR), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, RECORD_DIR), { recursive: true });
  expect(check([RECORD_DIR])).toBe(false);
});

test('directory whose only fresh file is nested is not verified', { timeout: 10_000 }, () => {
  write(projectRoot, `${RECORD_DIR}sub/validate.md`);
  expect(check([RECORD_DIR])).toBe(false);
});

test('missing directory, and trailing-slash path that is a file, are not verified', { timeout: 10_000 }, () => {
  expect(check([RECORD_DIR])).toBe(false);
  write(projectRoot, OTHER);
  expect(check([`${OTHER}/`])).toBe(false);
});

test('non-plan-records directory keeps the worktree fallback', { timeout: 10_000 }, () => {
  write(worktreeDir, `${OTHER_DIR}report.md`);
  expect(check([OTHER_DIR])).toBe(true);
});

test('verifyRun: validator-shaped PRD declaring the plan-records directory → pass_no_commit_artifact_verified', { timeout: 20_000 }, async () => {
  const { verifyRun } = require('../runVerify.cjs');
  const slug = '3900-validate-widget-runtime';
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-plan-run-'));
  try {
    write(projectRoot, `${RECORD_DIR}validate-widget-runtime.md`);
    const lines = ['[scheduler] starting ' + slug + ' at 2026-05-24T00:00:00.000Z'];
    lines.push(JSON.stringify({ type: 'result', subtype: 'success', result: 'All verified.\nSCHEDULER_VERDICT: PASS' }));
    lines.push('[scheduler] exit code=0 (raw code=0 signal=null) duration=47s');
    fs.writeFileSync(path.join(runDir, `${slug}.log`), lines.join('\n') + '\n');
    const prdPath = path.join(runDir, `${slug}.md`);
    fs.writeFileSync(prdPath, `---\ntitle: validate\ncwd: /tmp\nestimateMinutes: 30\ndeliverable: artifact\nartifactPaths: [${RECORD_DIR}]\n---\n# Goal\nvalidate\n`);
    const now = Date.now();
    const v = await verifyRun({
      runDir,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: projectRoot, startedAt: new Date(now - 10_000).toISOString(), finishedAt: new Date(now).toISOString() },
      allJobs: [],
      committedDuringRun: false,
    });
    expect(v.verdict).toBe('pass_no_commit_artifact_verified');
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
