/**
 * dod-drain-hook.test.cjs — drives the DoD drain handler.
 *
 * Run: timeout 120 node --test src/main/__tests__/dod-drain-hook.test.cjs
 *
 * Scenarios:
 *   1. Drain with completed jobs → writes report once.
 *   2. Second drain over same completed set → no-op (idempotent).
 *   3. SM_DOD_DISABLE=1 → no report.
 *   4. state.paused set → no report.
 *   5. cancelToken.cancelled = true → no report.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { runDefinitionOfDoneOnDrain } = require('../lib/dodDrainHook.cjs');
const { readWatermark } = require('../lib/definitionOfDone.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dod-drain-hook-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

/** Write a minimal PRD and return a completed-job record. */
function writePrd(prdsDir, slug, cwd) {
  const body = [
    '---',
    `title: ${slug}`,
    `cwd: ${cwd}`,
    'estimateMinutes: 5',
    '---',
    '',
    '# Goal',
    '',
    'Test fixture.',
    '',
    '# Acceptance criteria',
    '',
    '- [ ] `timeout 10 node -e "process.exit(0)"` passes.',
    '',
    '# Out of scope',
    '',
    '- N/A',
  ].join('\n');
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), body);
  return { slug, cwd, status: 'completed', runId: '2026-06-14T00-00-00-000Z' };
}

/** Count DoD report files under runsDir (shallow scan). */
function countReports(runsDir) {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(runsDir, entry.name);
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('definition-of-done-')) count++;
      }
    }
  } catch { /* runsDir may not exist */ }
  return count;
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('drain with completed jobs writes exactly one report', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  const job = writePrd(prdsDir, '101-test', cwd);
  const state = { paused: null, jobs: [job] };
  const cancelToken = { cancelled: false };
  const savedDisable = process.env.SM_DOD_DISABLE;
  delete process.env.SM_DOD_DISABLE;

  try {
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 1);
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    rmdir(tmpDir);
  }
});

test('second drain over same completed set is a no-op (idempotent)', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  const job = writePrd(prdsDir, '102-test', cwd);
  const state = { paused: null, jobs: [job] };
  const cancelToken = { cancelled: false };
  const savedDisable = process.env.SM_DOD_DISABLE;
  delete process.env.SM_DOD_DISABLE;

  try {
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    const afterFirst = countReports(runsDir);
    assert.strictEqual(afterFirst, 1, 'first call must write one report');

    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    const afterSecond = countReports(runsDir);
    assert.strictEqual(afterSecond, 1, 'second call with same jobs must be no-op');
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    rmdir(tmpDir);
  }
});

test('SM_DOD_DISABLE=1 → no report written', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  writePrd(prdsDir, '103-test', cwd);
  const job = { slug: '103-test', cwd, status: 'completed', runId: '2026-06-14T00-00-00-001Z' };
  const state = { paused: null, jobs: [job] };
  const cancelToken = { cancelled: false };
  const savedDisable = process.env.SM_DOD_DISABLE;
  process.env.SM_DOD_DISABLE = '1';

  try {
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 0, 'SM_DOD_DISABLE=1 must suppress the report');
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    else delete process.env.SM_DOD_DISABLE;
    rmdir(tmpDir);
  }
});

test('paused state → no report written', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  writePrd(prdsDir, '104-test', cwd);
  const job = { slug: '104-test', cwd, status: 'completed', runId: '2026-06-14T00-00-00-002Z' };
  const state = { paused: { reason: 'rate_limit', since: new Date().toISOString(), resumeAt: null }, jobs: [job] };
  const cancelToken = { cancelled: false };
  const savedDisable = process.env.SM_DOD_DISABLE;
  delete process.env.SM_DOD_DISABLE;

  try {
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 0, 'paused state must suppress the report');
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    rmdir(tmpDir);
  }
});

test('first-ever drain (no watermark file) processes all completed jobs', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  const jobA = writePrd(prdsDir, '106-old', cwd);
  jobA.finishedAt = '2020-01-01T00:00:00.000Z';
  const jobB = writePrd(prdsDir, '107-new', cwd);
  jobB.finishedAt = '2026-07-11T00:00:00.000Z';
  const state = { paused: null, jobs: [jobA, jobB] };
  const cancelToken = { cancelled: false };
  const savedDisable = process.env.SM_DOD_DISABLE;
  delete process.env.SM_DOD_DISABLE;

  try {
    assert.strictEqual(readWatermark(runsDir), null, 'no watermark should exist yet');
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 1);

    const reportsRoot = fs.readdirSync(runsDir, { withFileTypes: true }).filter(e => e.isDirectory());
    const reportFile = reportsRoot
      .map(e => path.join(runsDir, e.name))
      .flatMap(dir => fs.readdirSync(dir).filter(f => f.startsWith('definition-of-done-')).map(f => path.join(dir, f)))[0];
    const contents = fs.readFileSync(reportFile, 'utf8');
    assert.match(contents, /106-old/, 'first-ever drain must include old job too');
    assert.match(contents, /107-new/);
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    rmdir(tmpDir);
  }
});

test('subsequent drain with a persisted watermark only reverifies newer jobs', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, '.dod-watermark.json'),
    JSON.stringify({ lastFinishedAt: '2026-01-01T00:00:00.000Z' })
  );

  const jobOld = writePrd(prdsDir, '108-old', cwd);
  jobOld.finishedAt = '2025-01-01T00:00:00.000Z';
  const jobNew = writePrd(prdsDir, '109-new', cwd);
  jobNew.finishedAt = '2026-07-11T00:00:00.000Z';
  const state = { paused: null, jobs: [jobOld, jobNew] };
  const cancelToken = { cancelled: false };
  const savedDisable = process.env.SM_DOD_DISABLE;
  delete process.env.SM_DOD_DISABLE;

  try {
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 1);

    const reportsRoot = fs.readdirSync(runsDir, { withFileTypes: true }).filter(e => e.isDirectory());
    const reportFile = reportsRoot
      .map(e => path.join(runsDir, e.name))
      .flatMap(dir => fs.readdirSync(dir).filter(f => f.startsWith('definition-of-done-')).map(f => path.join(dir, f)))[0];
    const contents = fs.readFileSync(reportFile, 'utf8');
    assert.doesNotMatch(contents, /108-old/, 'jobs finished before the watermark must be excluded');
    assert.match(contents, /109-new/, 'jobs finished after the watermark must be included');
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    rmdir(tmpDir);
  }
});

test('watermark advances after a report so a repeat drain over the same jobs is a no-op', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  const job = writePrd(prdsDir, '110-test', cwd);
  job.finishedAt = '2026-07-11T00:00:00.000Z';
  const state = { paused: null, jobs: [job] };
  const cancelToken = { cancelled: false };
  const savedDisable = process.env.SM_DOD_DISABLE;
  delete process.env.SM_DOD_DISABLE;

  try {
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 1, 'first drain writes one report');
    assert.strictEqual(readWatermark(runsDir), job.finishedAt, 'watermark must advance to the covered job\'s finishedAt');

    // Second drain with a fresh job list containing the same already-covered job.
    const state2 = { paused: null, jobs: [{ ...job }] };
    await runDefinitionOfDoneOnDrain(state2, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 1, 'repeat drain over the same (now-old) job must be a no-op');
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    rmdir(tmpDir);
  }
});

test('cancelToken.cancelled=true → no report written', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const runsDir = path.join(tmpDir, 'runs');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  writePrd(prdsDir, '105-test', cwd);
  const job = { slug: '105-test', cwd, status: 'completed', runId: '2026-06-14T00-00-00-003Z' };
  const state = { paused: null, jobs: [job] };
  const cancelToken = { cancelled: true };
  const savedDisable = process.env.SM_DOD_DISABLE;
  delete process.env.SM_DOD_DISABLE;

  try {
    await runDefinitionOfDoneOnDrain(state, { cancelToken, prdsDir, runsDir });
    assert.strictEqual(countReports(runsDir), 0, 'cancelled token must suppress the report');
  } finally {
    if (savedDisable !== undefined) process.env.SM_DOD_DISABLE = savedDisable;
    rmdir(tmpDir);
  }
});
