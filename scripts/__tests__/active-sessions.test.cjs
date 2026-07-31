'use strict';

// Run: timeout 120 npx vitest run scripts/__tests__/active-sessions.test.cjs

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { activeProjectCwds } = require('../lib/activeSessions.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'active-sessions-test-'));
}

function writeTranscript(projectsDir, slug, fileName, cwd, mtimeMsAgo) {
  const projDir = path.join(projectsDir, slug);
  fs.mkdirSync(projDir, { recursive: true });
  const fp = path.join(projDir, fileName);
  fs.writeFileSync(fp, JSON.stringify({ cwd }) + '\n');
  const mtime = new Date(Date.now() - mtimeMsAgo);
  fs.utimesSync(fp, mtime, mtime);
  return fp;
}

test('two recent + one stale + one nonexistent → returns exactly the two recent existing cwds', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    const cwdB = path.join(base, 'proj-b');
    const cwdC = path.join(base, 'proj-c');       // stale — exists on disk
    const cwdMissing = path.join(base, 'proj-missing'); // never created
    fs.mkdirSync(cwdA);
    fs.mkdirSync(cwdB);
    fs.mkdirSync(cwdC);

    const MAX_AGE_MIN = 90;
    writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 10 * 60 * 1000);
    writeTranscript(projectsDir, 'slug-b', 'b.jsonl', cwdB, 10 * 60 * 1000);
    writeTranscript(projectsDir, 'slug-c', 'c.jsonl', cwdC, 120 * 60 * 1000);
    writeTranscript(projectsDir, 'slug-missing', 'm.jsonl', cwdMissing, 10 * 60 * 1000);

    const result = activeProjectCwds(MAX_AGE_MIN, { projectsDir });

    assert.equal(
      result.length, 2,
      `expected 2 cwds, got ${result.length}: ${JSON.stringify(result)}`,
    );
    assert.ok(result.includes(cwdA), `cwdA must be in result`);
    assert.ok(result.includes(cwdB), `cwdB must be in result`);
    assert.ok(!result.includes(cwdC),       'stale cwdC must not appear');
    assert.ok(!result.includes(cwdMissing), 'nonexistent path must not appear');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('duplicate cwd across two project dirs → deduped to one entry', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);

    writeTranscript(projectsDir, 'slug-1', 'a.jsonl', cwdA, 5 * 60 * 1000);
    writeTranscript(projectsDir, 'slug-2', 'b.jsonl', cwdA, 5 * 60 * 1000);

    const result = activeProjectCwds(90, { projectsDir });
    assert.equal(result.length, 1, 'duplicate cwd must be deduped');
    assert.equal(result[0], cwdA);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('missing projects dir → empty result', () => {
  const base = tmpDir();
  try {
    const result = activeProjectCwds(90, { projectsDir: path.join(base, 'no-such-dir') });
    assert.deepEqual(result, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('prompts.jsonl absent → transcripts still detected (sole detection path)', () => {
  const base = tmpDir();
  try {
    // No knowledge-log / prompts.jsonl anywhere in this tmp tree — the
    // function must not need it. logPath, if passed, is a harmless no-op.
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);

    writeTranscript(projectsDir, 'slug-a', 'a.jsonl', cwdA, 5 * 60 * 1000);

    const missingLogPath = path.join(base, 'knowledge-log', 'prompts.jsonl');
    assert.ok(!fs.existsSync(missingLogPath), 'sanity: log path must not exist');

    const result = activeProjectCwds(90, { projectsDir, logPath: missingLogPath });
    assert.deepEqual(result, [cwdA]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fresh transcript mtime with no prompt log present → cwd is returned', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-fresh');
    fs.mkdirSync(cwdA);

    writeTranscript(projectsDir, 'slug-fresh', 'fresh.jsonl', cwdA, 60 * 1000); // 1 min ago

    const result = activeProjectCwds(90, { projectsDir });
    assert.equal(result.length, 1);
    assert.equal(result[0], cwdA);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('garbage lines in transcript are skipped, cwd read from last parseable line', () => {
  const base = tmpDir();
  try {
    const projectsDir = path.join(base, 'projects');
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);

    const projDir = path.join(projectsDir, 'slug-a');
    fs.mkdirSync(projDir, { recursive: true });
    const fp = path.join(projDir, 'a.jsonl');
    fs.writeFileSync(fp, [
      JSON.stringify({ cwd: cwdA }),
      'not json at all!!!',
      '{ broken',
    ].join('\n') + '\n');
    const mtime = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(fp, mtime, mtime);

    const result = activeProjectCwds(90, { projectsDir });
    assert.equal(result.length, 1);
    assert.equal(result[0], cwdA);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
