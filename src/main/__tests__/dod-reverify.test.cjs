/**
 * dod-reverify.test.cjs — unit tests for extractAcCommand / reverifyAc / reverifyBatch.
 *
 * Run: timeout 180 node --test src/main/__tests__/dod-reverify.test.cjs
 *
 * Fixtures: os.tmpdir() only — never touches the real prds dir or scheduler queue.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { extractAcCommand, reverifyAc, reverifyBatch } = require('../lib/definitionOfDone.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dod-reverify-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

/** Write a minimal PRD file and return the job object. */
function writePrd(prdsDir, slug, acLine, cwd) {
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
    acLine,
    '',
    '# Out of scope',
    '',
    '- N/A',
  ].join('\n');
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), body);
  return { slug, cwd };
}

// ─── extractAcCommand: backtick-quoted timeout ─────────────────────────────

test('extractAcCommand: extracts timeout from backtick-quoted inline code', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] Test `timeout 120 node --test src/main/__tests__/foo.test.cjs` passes.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 120 node --test src/main/__tests__/foo.test.cjs');
});

test('extractAcCommand: extracts timeout from raw (non-backtick) AC line', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] timeout 60 node -c src/main/lib/definitionOfDone.cjs',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 60 node -c src/main/lib/definitionOfDone.cjs');
});

test('extractAcCommand: returns first timeout command when multiple AC lines match', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] `timeout 60 node -c foo.cjs` parses clean.',
    '- [ ] `timeout 120 node --test bar.test.cjs` passes.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 60 node -c foo.cjs');
});

test('extractAcCommand: returns null when no timeout command in AC section', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] The widget renders without errors.',
    '- [ ] The config file is valid JSON.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), null);
});

test('extractAcCommand: returns null for null/empty body', () => {
  assert.strictEqual(extractAcCommand(null), null);
  assert.strictEqual(extractAcCommand(''), null);
  assert.strictEqual(extractAcCommand(undefined), null);
});

test('extractAcCommand: skips commands with shell pipes (needs shell:true)', () => {
  const body = [
    '# Acceptance criteria',
    '',
    '- [ ] `timeout 150 python -m pytest 2>&1 | tail -15` passes.',
    '- [ ] `timeout 60 node -c src/lib/foo.cjs` parses clean.',
  ].join('\n');
  // Pipe command is rejected; falls back to the second clean command.
  assert.strictEqual(extractAcCommand(body), 'timeout 60 node -c src/lib/foo.cjs');
});

test('extractAcCommand: works when body contains frontmatter strip artifact', () => {
  const body = [
    '# Goal',
    '',
    'Do something.',
    '',
    '# Acceptance criteria',
    '',
    '- [ ] `timeout 30 node --test tests/foo.test.cjs` passes.',
  ].join('\n');
  assert.strictEqual(extractAcCommand(body), 'timeout 30 node --test tests/foo.test.cjs');
});

// ─── reverifyAc: pass ─────────────────────────────────────────────────────────

test('reverifyAc: returns pass when AC command exits 0', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  // Write a tiny node script that exits 0
  fs.writeFileSync(path.join(cwd, 'ok.cjs'), 'process.exit(0);');

  const job = writePrd(prdsDir, '101-pass', '- [ ] `timeout 10 node ok.cjs` succeeds.', cwd);
  try {
    const result = await reverifyAc(job, { timeoutMs: 15_000, prdsDir });
    assert.strictEqual(result.slug, '101-pass');
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.code, 0);
    assert.ok(typeof result.ms === 'number' && result.ms >= 0, `ms should be >= 0, got ${result.ms}`);
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyAc: fail ─────────────────────────────────────────────────────────

test('reverifyAc: returns fail when AC command exits non-zero', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'fail.cjs'), 'process.exit(1);');

  const job = writePrd(prdsDir, '102-fail', '- [ ] `timeout 10 node fail.cjs` succeeds.', cwd);
  try {
    const result = await reverifyAc(job, { timeoutMs: 15_000, prdsDir });
    assert.strictEqual(result.slug, '102-fail');
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.code, 1);
    assert.ok(typeof result.ms === 'number' && result.ms >= 0);
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyAc: unverifiable ─────────────────────────────────────────────────

test('reverifyAc: returns unverifiable when PRD has no parseable AC command', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  const job = writePrd(prdsDir, '103-nocmd', '- [ ] The widget renders correctly.', cwd);
  try {
    const result = await reverifyAc(job, { timeoutMs: 15_000, prdsDir });
    assert.strictEqual(result.slug, '103-nocmd');
    assert.strictEqual(result.status, 'unverifiable');
    assert.strictEqual(result.code, null);
  } finally {
    rmdir(tmpDir);
  }
});

test('reverifyAc: returns unverifiable when cwd does not exist', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  fs.mkdirSync(prdsDir);
  const missingCwd = path.join(tmpDir, 'nonexistent-project');

  const job = writePrd(prdsDir, '104-nocwd', '- [ ] `timeout 5 node -e "process.exit(0)"` passes.', missingCwd);
  try {
    const result = await reverifyAc(job, { timeoutMs: 15_000, prdsDir });
    assert.strictEqual(result.status, 'unverifiable');
  } finally {
    rmdir(tmpDir);
  }
});

test('reverifyAc: returns unverifiable when PRD file does not exist', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  // job.slug points to a missing .md file
  const job = { slug: '105-missing-prd', cwd };
  try {
    const result = await reverifyAc(job, { timeoutMs: 15_000, prdsDir });
    assert.strictEqual(result.status, 'unverifiable');
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyBatch: all three statuses ────────────────────────────────────────

test('reverifyBatch: returns pass/fail/unverifiable for a mixed batch', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  fs.writeFileSync(path.join(cwd, 'ok.cjs'), 'process.exit(0);');
  fs.writeFileSync(path.join(cwd, 'fail.cjs'), 'process.exit(1);');

  const jobPass = writePrd(prdsDir, '201-pass', '- [ ] `timeout 10 node ok.cjs` passes.', cwd);
  const jobFail = writePrd(prdsDir, '202-fail', '- [ ] `timeout 10 node fail.cjs` passes.', cwd);
  const jobNone = writePrd(prdsDir, '203-noop', '- [ ] The result is correct.', cwd);

  try {
    const results = await reverifyBatch([jobPass, jobFail, jobNone], {
      timeoutMs: 15_000,
      batchTimeoutMs: 120_000,
      prdsDir,
    });
    assert.strictEqual(results.length, 3);

    const bySlug = Object.fromEntries(results.map((r) => [r.slug, r]));
    assert.strictEqual(bySlug['201-pass'].status, 'pass');
    assert.strictEqual(bySlug['202-fail'].status, 'fail');
    assert.strictEqual(bySlug['203-noop'].status, 'unverifiable');
  } finally {
    rmdir(tmpDir);
  }
});

// ─── reverifyBatch: batch wall-time cap ───────────────────────────────────────

test('reverifyBatch: marks remaining jobs unverifiable when batch cap is hit', async () => {
  const tmpDir = makeTmpDir();
  const prdsDir = path.join(tmpDir, 'prds');
  const cwd = path.join(tmpDir, 'project');
  fs.mkdirSync(prdsDir);
  fs.mkdirSync(cwd);

  // Slow job — sleeps longer than batchTimeoutMs
  fs.writeFileSync(path.join(cwd, 'slow.cjs'), 'setTimeout(() => process.exit(0), 30_000);');
  const jobSlow = writePrd(prdsDir, '301-slow', '- [ ] `timeout 60 node slow.cjs` passes.', cwd);
  fs.writeFileSync(path.join(cwd, 'ok.cjs'), 'process.exit(0);');
  const jobAfter = writePrd(prdsDir, '302-after', '- [ ] `timeout 10 node ok.cjs` passes.', cwd);

  try {
    // Kill the slow job after 500ms; the batch cap (200ms) ensures jobAfter
    // is never started. Total test wall-time ≈ 500ms.
    const results = await reverifyBatch([jobSlow, jobAfter], {
      timeoutMs: 500,
      batchTimeoutMs: 200,
      prdsDir,
    });
    assert.strictEqual(results.length, 2);
    // The slow job ran but the batch cap check fires before jobAfter starts.
    // (The slow job itself may finish or not within the timeoutMs; we only care
    // that jobAfter is unverifiable due to the batch cap.)
    const after = results.find((r) => r.slug === '302-after');
    assert.strictEqual(after.status, 'unverifiable');
  } finally {
    rmdir(tmpDir);
  }
});
