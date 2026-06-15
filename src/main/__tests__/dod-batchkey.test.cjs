/**
 * dod-batchkey.test.cjs — unit tests for definitionOfDone.cjs helpers.
 *
 * Run: timeout 120 node --test src/main/__tests__/dod-batchkey.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { batchKey, reportPathFor, reportExists } = require('../lib/definitionOfDone.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dod-batchkey-test-'));
}

function rmdir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
}

function makeJob(slug, runId) {
  return { slug, runId };
}

// ─── batchKey: order-independence ─────────────────────────────────────────────

test('batchKey is order-independent', () => {
  const jobsA = [
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
    makeJob('102-bar', '2026-06-01T11-00-00-000Z'),
  ];
  const jobsB = [
    makeJob('102-bar', '2026-06-01T11-00-00-000Z'),
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
  ];
  assert.strictEqual(batchKey(jobsA), batchKey(jobsB));
});

// ─── batchKey: adding a real job changes the key ─────────────────────────────

test('adding a real job changes the batchKey', () => {
  const base = [
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
  ];
  const extended = [
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
    makeJob('102-bar', '2026-06-01T11-00-00-000Z'),
  ];
  assert.notStrictEqual(batchKey(base), batchKey(extended));
});

// ─── batchKey: adding a meta/dod job does NOT change the key ─────────────────

test('adding a dod-prefixed slug does not change batchKey', () => {
  const base = [makeJob('101-foo', '2026-06-01T10-00-00-000Z')];
  const withDod = [
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
    makeJob('dod-gate', '2026-06-01T12-00-00-000Z'),
  ];
  assert.strictEqual(batchKey(base), batchKey(withDod));
});

test('adding a dod-suffixed slug does not change batchKey', () => {
  const base = [makeJob('101-foo', '2026-06-01T10-00-00-000Z')];
  const withDod = [
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
    makeJob('gate-dod', '2026-06-01T12-00-00-000Z'),
  ];
  assert.strictEqual(batchKey(base), batchKey(withDod));
});

test('adding a definition-of-done slug does not change batchKey', () => {
  const base = [makeJob('101-foo', '2026-06-01T10-00-00-000Z')];
  const withDod = [
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
    makeJob('definition-of-done-pass', '2026-06-01T12-00-00-000Z'),
  ];
  assert.strictEqual(batchKey(base), batchKey(withDod));
});

test('adding an inline dod slug (dod between dashes) does not change batchKey', () => {
  const base = [makeJob('101-foo', '2026-06-01T10-00-00-000Z')];
  const withDod = [
    makeJob('101-foo', '2026-06-01T10-00-00-000Z'),
    makeJob('batch-dod-check', '2026-06-01T12-00-00-000Z'),
  ];
  assert.strictEqual(batchKey(base), batchKey(withDod));
});

// ─── batchKey: empty set ──────────────────────────────────────────────────────

test('empty job list produces a stable key', () => {
  assert.strictEqual(typeof batchKey([]), 'string');
  assert.strictEqual(batchKey([]), batchKey([]));
});

// ─── batchKey: same slug different runId produces different keys ──────────────

test('same slug but different runId produces different keys', () => {
  const a = [makeJob('101-foo', '2026-06-01T10-00-00-000Z')];
  const b = [makeJob('101-foo', '2026-06-01T11-00-00-000Z')];
  assert.notStrictEqual(batchKey(a), batchKey(b));
});

// ─── reportPathFor ────────────────────────────────────────────────────────────

test('reportPathFor returns a path ending with definition-of-done-<key>.md', () => {
  const key = batchKey([makeJob('101-foo', '2026-06-01T10-00-00-000Z')]);
  const p = reportPathFor(key);
  assert.ok(p.endsWith(`definition-of-done-${key}.md`), `path: ${p}`);
  assert.ok(p.includes('scheduled-plans/runs/'), `path: ${p}`);
});

// ─── reportExists ─────────────────────────────────────────────────────────────

test('reportExists returns false when runs/ dir does not exist', () => {
  const key = batchKey([makeJob('101-foo', '2026-06-01T10-00-00-000Z')]);
  const tmpDir = makeTmpDir();
  try {
    const runsDir = path.join(tmpDir, 'runs');
    // runsDir intentionally not created
    assert.strictEqual(reportExists(key, runsDir), false);
  } finally {
    rmdir(tmpDir);
  }
});

test('reportExists returns false when no matching file exists', () => {
  const key = batchKey([makeJob('101-foo', '2026-06-01T10-00-00-000Z')]);
  const tmpDir = makeTmpDir();
  try {
    const runsDir = path.join(tmpDir, 'runs');
    const runDir = path.join(runsDir, '2026-06-01T10-00-00-000Z');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'some-other-file.md'), '# other');
    assert.strictEqual(reportExists(key, runsDir), false);
  } finally {
    rmdir(tmpDir);
  }
});

test('reportExists returns true when matching file exists in any run subdir', () => {
  const key = batchKey([makeJob('101-foo', '2026-06-01T10-00-00-000Z')]);
  const tmpDir = makeTmpDir();
  try {
    const runsDir = path.join(tmpDir, 'runs');
    const runDir = path.join(runsDir, '2026-06-01T10-00-00-000Z');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, `definition-of-done-${key}.md`),
      '# DoD report'
    );
    assert.strictEqual(reportExists(key, runsDir), true);
  } finally {
    rmdir(tmpDir);
  }
});

test('reportExists finds match in a nested run directory (not first subdir)', () => {
  const key = batchKey([makeJob('101-foo', '2026-06-01T10-00-00-000Z')]);
  const tmpDir = makeTmpDir();
  try {
    const runsDir = path.join(tmpDir, 'runs');
    // Two subdirs; match is in the second
    const runDir1 = path.join(runsDir, '2026-06-01T09-00-00-000Z');
    const runDir2 = path.join(runsDir, '2026-06-01T10-00-00-000Z');
    fs.mkdirSync(runDir1, { recursive: true });
    fs.mkdirSync(runDir2, { recursive: true });
    fs.writeFileSync(path.join(runDir1, 'other.md'), '# other');
    fs.writeFileSync(
      path.join(runDir2, `definition-of-done-${key}.md`),
      '# DoD report'
    );
    assert.strictEqual(reportExists(key, runsDir), true);
  } finally {
    rmdir(tmpDir);
  }
});
