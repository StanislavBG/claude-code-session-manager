/**
 * runVerify-transcript-commit-evidence.test.cjs — regression tests for the
 * transcript-commit-evidence fallback added to runVerify.cjs.
 *
 * Root cause (99-fix-e2e-needs-review-test, 2026-08-07): a job whose cwd is
 * not a git repo (e.g. an investigation fix-plan that inherited cwd: /tmp)
 * can never produce committedDuringRun=true — gitHead()/committedInWindow()
 * both fail closed there — so the PASS+commit sentinel override could never
 * fire even when the harness's own transcript recorded a real commit. This
 * file asserts the fallback fires ONLY when both conditions hold: the cwd is
 * genuinely not a git repo, AND the transcript itself carries harness-emitted
 * commit evidence (never inferred from prose the model could fabricate).
 *
 * Run standalone: timeout 120 npx vitest run src/main/__tests__/runVerify-transcript-commit-evidence.test.cjs
 */

import { test } from 'vitest';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyRun } = require('../runVerify.cjs');

// ─── helpers (mirrors runVerify.test.cjs) ─────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-commit-evidence-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function writeLog(dir, slug, events) {
  const lines = ['[scheduler] starting ' + slug + ' at 2026-08-07T02:25:31.453Z'];
  for (const ev of events) lines.push(JSON.stringify(ev));
  lines.push('[scheduler] exit code=0 (raw code=0 signal=null) duration=47s');
  fs.writeFileSync(path.join(dir, `${slug}.log`), lines.join('\n') + '\n');
}

function writePrd(dir, slug, body) {
  const text = `---\ntitle: Test PRD\ncwd: /tmp\nestimateMinutes: 30\n---\n${body}\n`;
  fs.writeFileSync(path.join(dir, `${slug}.md`), text);
  return path.join(dir, `${slug}.md`);
}

function makeTmpGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-commit-evidence-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/**
 * Build a run log with:
 *   - padding events so a late is_error lands in the final 20%
 *   - a late is_error tool_result (main-agent, no self-recovery)
 *   - optionally a harness-emitted commit-evidence line
 *   - a SCHEDULER_VERDICT: PASS result event
 */
function buildRunEvents({ includeCommitEvidence, evidenceForm = 'vcs_state_changed' }) {
  const events = [];
  for (let k = 0; k < 8; k++) {
    events.push({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: `t${k}`, name: 'Read', input: { description: `read ${k}` } }] } });
    events.push({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `t${k}`, content: 'ok', is_error: false }] } });
  }
  events.push({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tbad', name: 'Agent', input: { description: 'run code review agent' } }] } });
  events.push({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tbad',
      content: "Agent type 'code-reviewer' not found. Available agents: architect, …", is_error: true }] } });

  if (includeCommitEvidence) {
    if (evidenceForm === 'vcs_state_changed') {
      events.push({ type: 'system', subtype: 'vcs_state_changed', kind: 'commit', cwd: '/tmp' });
    } else {
      events.push({
        type: 'user',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tcommit', content: 'committed', is_error: false }] },
        tool_use_result: { gitOperation: { commit: { sha: '6ecbd40', kind: 'committed' } } },
      });
    }
  }

  events.push({ type: 'result', subtype: 'success', result: 'All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS' });
  return events;
}

// ─── (1) regression case: non-git cwd + transcript evidence → clean ──────────

test('PASS + late is_error + transcript commit evidence + non-git cwd → clean (fallback fires)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '99-fix-e2e-needs-review-test';
    writeLog(tmp, slug, buildRunEvents({ includeCommitEvidence: true }));
    const prdPath = writePrd(tmp, slug, '# Fix scheduler skip guard');
    const nonGitCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-nongit-cwd-'));
    try {
      const verdict = await verifyRun({
        runDir: tmp,
        prdPath,
        queueEntry: { slug, status: 'running', cwd: nonGitCwd },
        allJobs: [],
        committedDuringRun: false,
      });
      assert.equal(verdict.verdict, 'clean', `expected clean via transcript fallback, got ${verdict.verdict}: ${verdict.reason}`);
      assert.equal(verdict.downgradeTo, null);
      const sidecar = JSON.parse(fs.readFileSync(path.join(tmp, `${slug}.verdicts.json`), 'utf8'));
      assert.equal(sidecar.commitEvidenceSource, 'transcript', 'sidecar should record the fallback source');
    } finally { rmdir(nonGitCwd); }
  } finally { rmdir(tmp); }
});

test('PASS + late is_error + gitOperation.commit evidence + non-git cwd → clean (fallback fires)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '99-fix-e2e-needs-review-test-alt';
    writeLog(tmp, slug, buildRunEvents({ includeCommitEvidence: true, evidenceForm: 'gitOperation' }));
    const prdPath = writePrd(tmp, slug, '# Fix scheduler skip guard');
    const nonGitCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-nongit-cwd-'));
    try {
      const verdict = await verifyRun({
        runDir: tmp,
        prdPath,
        queueEntry: { slug, status: 'running', cwd: nonGitCwd },
        allJobs: [],
        committedDuringRun: false,
      });
      assert.equal(verdict.verdict, 'clean', `expected clean via transcript fallback, got ${verdict.verdict}: ${verdict.reason}`);
    } finally { rmdir(nonGitCwd); }
  } finally { rmdir(tmp); }
});

// ─── (2) no evidence lines → fallback must not fire, still transcript_errors ──

test('PASS + late is_error + NO transcript evidence + non-git cwd → transcript_errors (no fallback)', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '99-fix-no-evidence';
    writeLog(tmp, slug, buildRunEvents({ includeCommitEvidence: false }));
    const prdPath = writePrd(tmp, slug, '# Fix scheduler skip guard');
    const nonGitCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-nongit-cwd-'));
    try {
      const verdict = await verifyRun({
        runDir: tmp,
        prdPath,
        queueEntry: { slug, status: 'running', cwd: nonGitCwd },
        allJobs: [],
        committedDuringRun: false,
      });
      assert.equal(verdict.verdict, 'transcript_errors', `expected transcript_errors without evidence, got ${verdict.verdict}: ${verdict.reason}`);
      assert.equal(verdict.downgradeTo, 'needs_review');
    } finally { rmdir(nonGitCwd); }
  } finally { rmdir(tmp); }
});

// ─── (3) git-repo cwd + evidence + committedDuringRun:false → fallback must not apply ──

test('PASS + late is_error + transcript evidence + GIT-REPO cwd + committedDuringRun:false → transcript_errors (false-PASS guard)', async () => {
  const tmp = makeTmpDir();
  const repo = makeTmpGitRepo();
  try {
    const slug = '99-fix-git-repo-cwd';
    writeLog(tmp, slug, buildRunEvents({ includeCommitEvidence: true }));
    const prdPath = writePrd(tmp, slug, '# Fix scheduler skip guard');
    const verdict = await verifyRun({
      runDir: tmp,
      prdPath,
      queueEntry: { slug, status: 'running', cwd: repo },
      allJobs: [],
      committedDuringRun: false,
    });
    assert.equal(verdict.verdict, 'transcript_errors', `fallback must not apply when git ancestry is observable, got ${verdict.verdict}: ${verdict.reason}`);
    assert.equal(verdict.downgradeTo, 'needs_review');
  } finally { rmdir(tmp); rmdir(repo); }
});

// ─── (4) PASS + transcript evidence + non-git cwd must not be pass_no_commit ──

test('PASS (no error) + transcript evidence + non-git cwd → clean, not pass_no_commit', async () => {
  const tmp = makeTmpDir();
  try {
    const slug = '99-fix-clean-pass';
    const events = [
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't0', name: 'Bash', input: { description: 'run tests' } }] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't0', content: '535 passed', is_error: false }] } },
      { type: 'system', subtype: 'vcs_state_changed', kind: 'commit', cwd: '/tmp' },
      { type: 'result', subtype: 'success', result: 'All acceptance criteria verified.\nSCHEDULER_VERDICT: PASS' },
    ];
    writeLog(tmp, slug, events);
    const prdPath = writePrd(tmp, slug, '# Fix scheduler skip guard');
    const nonGitCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-nongit-cwd-'));
    try {
      const verdict = await verifyRun({
        runDir: tmp,
        prdPath,
        queueEntry: { slug, status: 'running', cwd: nonGitCwd },
        allJobs: [],
        committedDuringRun: false,
      });
      assert.equal(verdict.verdict, 'clean', `expected clean, got ${verdict.verdict}: ${verdict.reason}`);
      assert.notEqual(verdict.verdict, 'pass_no_commit');
    } finally { rmdir(nonGitCwd); }
  } finally { rmdir(tmp); }
});
