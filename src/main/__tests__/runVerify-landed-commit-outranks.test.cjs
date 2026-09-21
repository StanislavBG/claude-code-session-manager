/**
 * runVerify-landed-commit-outranks.test.cjs — ground truth (exit 0 + a commit
 * landed THIS run + no explicit FAIL sentinel) outranks the transcript-
 * pattern heuristics (final-20% is_error, FAIL/Traceback,
 * ModuleNotFoundError), so a self-recovered tool error no longer parks a
 * green, committed run.
 *
 * Fixture: the REAL run log for 1218-fo-01-move-scripts-lib-into-src-main-lib
 * (session-manager-operations/reviews/2026-09-13-scheduler-stability-
 * investigation.md), copied verbatim from
 * ~/.claude/session-manager/scheduled-plans/runs/2026-09-13T21-52-51-192Z/ —
 * a `git apply` "patch does not apply" tool error at event 179/209 (inside
 * the final 20% of the transcript) that the agent retried and resolved 3
 * events later, in a run that landed commit d1edf15 and was STILL parked
 * needs_review (verdicts.json: verdict transcript_errors, reason
 * "is_error=true in final 20% of transcript (event 179/209)"), spawning a
 * $3.74 fix-plan investigation into work that needed no fix.
 *
 * The real run's own SCHEDULER_VERDICT sentinel is an explicit FAIL — an
 * honest, UNRELATED report that test:unit was red for proven pre-existing/
 * environmental reasons (shared /tmp contention), not a regression from this
 * PRD's move. Per this PRD's own AC, an explicit FAIL sentinel must keep
 * today's behavior byte-for-byte, so scenarios (a)/(b)/(d) below use a
 * variant of the fixture with that trailing SCHEDULER_VERDICT line stripped
 * (sentinel === null) — the majority real-world park shape this rule targets
 * (the findings report measured 77 of 212 parks as transcript_errors with NO
 * sentinel at all, vs. this one specific row's own additional, unrelated
 * FAIL claim). Scenario (c) reuses the pristine, byte-for-byte-unmodified
 * fixture to prove the real, still-present FAIL sentinel is honored exactly
 * as before this change.
 *
 * Run standalone: timeout 120 npx vitest run src/main/__tests__/runVerify-landed-commit-outranks.test.cjs
 */

import { test, beforeAll, afterAll, vi } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyRun } = require('../runVerify.cjs');

// Sidecar goes through config.writeJsonSync, whose allow-list rejects os.tmpdir() fixtures.
let writeSpy;
beforeAll(() => {
  writeSpy = vi.spyOn(require('../config.cjs'), 'writeJsonSync').mockImplementation((abs, data) => {
    require('node:fs').writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
    return { ok: true, mtimeMs: 0 };
  });
});
afterAll(() => writeSpy.mockRestore());

const SLUG = '1218-fo-01-move-scripts-lib-into-src-main-lib';
const FIXTURE_PATH = path.join(__dirname, 'fixtures', `${SLUG}.log`);
const LANDED_COMMIT = 'd1edf15be50a783f08a55e6de328780f0feb3cb0';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-landed-commit-outranks-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function makeTmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-landed-commit-outranks-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function writePrd(dir, slug) {
  const text = '---\ntitle: Test PRD\ncwd: /tmp\nestimateMinutes: 30\n---\n# Move scripts/lib into src/main/lib\n';
  fs.writeFileSync(path.join(dir, `${slug}.md`), text);
  return path.join(dir, `${slug}.md`);
}

/**
 * Load the real fixture log, optionally stripping the trailing
 * `SCHEDULER_VERDICT: FAIL ...` line from the final `{"type":"result",...}`
 * event's `result` field so the sentinel scan sees no sentinel at all.
 */
function loadFixture({ stripFailSentinel }) {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  if (!stripFailSentinel) return raw;
  const lines = raw.split('\n');
  const idx = lines.findIndex((l) => l.includes('"type":"result"'));
  assert.ok(idx !== -1, 'fixture must contain a type:result line');
  const obj = JSON.parse(lines[idx]);
  assert.ok(/SCHEDULER_VERDICT:\s*FAIL/.test(obj.result), 'fixture result must carry the real FAIL sentinel before stripping');
  obj.result = obj.result.replace(/\n?SCHEDULER_VERDICT:\s*FAIL[^\n]*$/, '');
  assert.ok(!/SCHEDULER_VERDICT/.test(obj.result), 'sentinel must be fully removed from the stripped variant');
  lines[idx] = JSON.stringify(obj);
  return lines.join('\n');
}

function writeLog(dir, slug, text) {
  fs.writeFileSync(path.join(dir, `${slug}.log`), text);
}

// (a) exit 0 + commit landed THIS run + no sentinel at all → clean, demoted to annotation.
test('exit 0 + landed commit this run + no FAIL sentinel → clean with annotation (1218-fo-01)', async () => {
  const tmp = makeTmpDir();
  const repo = makeTmpGitRepo();
  try {
    writeLog(tmp, SLUG, loadFixture({ stripFailSentinel: true }));
    const prdPath = writePrd(tmp, SLUG);
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug: SLUG, status: 'running', cwd: repo },
      allJobs: [],
      committedDuringRun: false,
      jobLandedCommitThisRun: LANDED_COMMIT,
      exitCode: 0,
    });
    assert.equal(verdict.verdict, 'clean', `expected clean, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, null);
    const sidecar = JSON.parse(fs.readFileSync(path.join(tmp, `${SLUG}.verdicts.json`), 'utf8'));
    assert.ok(Array.isArray(sidecar.annotations) && sidecar.annotations.length > 0, 'the demoted is_error hit must be recorded as an annotation');
    assert.ok(sidecar.annotations.some((a) => a.verdict === 'transcript_errors'), 'annotation must carry the original transcript_errors verdict');
  } finally { rmdir(tmp); rmdir(repo); }
});

// (b) the same (stripped-sentinel) log, but exitCode !== 0 → keeps today's behavior.
test('non-zero exit → transcript_errors (evidence never applies to a failing run)', async () => {
  const tmp = makeTmpDir();
  const repo = makeTmpGitRepo();
  try {
    writeLog(tmp, SLUG, loadFixture({ stripFailSentinel: true }));
    const prdPath = writePrd(tmp, SLUG);
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug: SLUG, status: 'running', cwd: repo },
      allJobs: [],
      committedDuringRun: false,
      jobLandedCommitThisRun: LANDED_COMMIT,
      exitCode: 1,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `expected transcript_errors, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally { rmdir(tmp); rmdir(repo); }
});

// (c) the pristine, byte-for-byte-unmodified fixture — its own real FAIL sentinel — keeps today's behavior.
test('explicit FAIL sentinel (the real, unmodified fixture) → transcript_errors byte-for-byte', async () => {
  const tmp = makeTmpDir();
  const repo = makeTmpGitRepo();
  try {
    writeLog(tmp, SLUG, loadFixture({ stripFailSentinel: false }));
    const prdPath = writePrd(tmp, SLUG);
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug: SLUG, status: 'running', cwd: repo },
      allJobs: [],
      committedDuringRun: false,
      jobLandedCommitThisRun: LANDED_COMMIT,
      exitCode: 0,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `expected transcript_errors, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
    assert.equal(verdict.sentinel, 'fail');
  } finally { rmdir(tmp); rmdir(repo); }
});

// (d) no landed-commit evidence at all → transcript_errors (evidence gate requires attribution).
test('no landed commit evidence → transcript_errors (evidence gate requires attribution)', async () => {
  const tmp = makeTmpDir();
  const repo = makeTmpGitRepo();
  try {
    writeLog(tmp, SLUG, loadFixture({ stripFailSentinel: true }));
    const prdPath = writePrd(tmp, SLUG);
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug: SLUG, status: 'running', cwd: repo },
      allJobs: [],
      committedDuringRun: false,
      jobLandedCommitThisRun: null,
      exitCode: 0,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `expected transcript_errors, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally { rmdir(tmp); rmdir(repo); }
});
