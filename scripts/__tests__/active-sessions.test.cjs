'use strict';

// Run: timeout 120 node --test scripts/__tests__/active-sessions.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { activeProjectCwds } = require('../lib/activeSessions.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'active-sessions-test-'));
}

test('two recent + one stale + one nonexistent → returns exactly the two recent existing cwds', () => {
  const base = tmpDir();
  try {
    const cwdA = path.join(base, 'proj-a');
    const cwdB = path.join(base, 'proj-b');
    const cwdC = path.join(base, 'proj-c');       // stale — exists on disk
    const cwdMissing = path.join(base, 'proj-missing'); // never created
    fs.mkdirSync(cwdA);
    fs.mkdirSync(cwdB);
    fs.mkdirSync(cwdC);

    const MAX_AGE_MIN = 90;
    const now = Date.now();
    const recentTs = new Date(now - 10 * 60 * 1000).toISOString();   // 10 min ago
    const staleTs  = new Date(now - 120 * 60 * 1000).toISOString();  // 2 h ago

    const logPath = path.join(base, 'prompts.jsonl');
    const lines = [
      JSON.stringify({ ts: recentTs, session_id: 's1', cwd: cwdA, prompt: 'hello' }),
      JSON.stringify({ ts: recentTs, session_id: 's2', cwd: cwdB, prompt: 'world' }),
      JSON.stringify({ ts: staleTs,  session_id: 's3', cwd: cwdC, prompt: 'old' }),
      JSON.stringify({ ts: recentTs, session_id: 's4', cwd: cwdMissing, prompt: 'ghost' }),
    ];
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const result = activeProjectCwds(MAX_AGE_MIN, { logPath });

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

test('duplicate cwd in log → deduped to one entry', () => {
  const base = tmpDir();
  try {
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);

    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const logPath = path.join(base, 'prompts.jsonl');
    fs.writeFileSync(logPath, [
      JSON.stringify({ ts: recentTs, cwd: cwdA, prompt: 'first' }),
      JSON.stringify({ ts: recentTs, cwd: cwdA, prompt: 'second' }),
    ].join('\n') + '\n');

    const result = activeProjectCwds(90, { logPath });
    assert.equal(result.length, 1, 'duplicate cwd must be deduped');
    assert.equal(result[0], cwdA);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('missing log → empty result (primary path unavailable)', () => {
  const base = tmpDir();
  try {
    const missingLog = path.join(base, 'no-such-file.jsonl');
    // Also no projects dir override — fallback would need projectsDir, we just
    // verify the primary gracefully returns [] when log is missing.
    const result = activeProjectCwds(90, { logPath: missingLog, projectsDir: path.join(base, 'empty-projects') });
    assert.deepEqual(result, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('epoch-ms ts format is accepted', () => {
  const base = tmpDir();
  try {
    const cwdA = path.join(base, 'proj-epoch');
    fs.mkdirSync(cwdA);

    const recentEpochMs = Date.now() - 5 * 60 * 1000;
    const logPath = path.join(base, 'prompts.jsonl');
    fs.writeFileSync(logPath,
      JSON.stringify({ ts: recentEpochMs, cwd: cwdA, prompt: 'epoch test' }) + '\n',
    );

    const result = activeProjectCwds(90, { logPath });
    assert.equal(result.length, 1);
    assert.equal(result[0], cwdA);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('garbage lines in log are skipped, valid lines still returned', () => {
  const base = tmpDir();
  try {
    const cwdA = path.join(base, 'proj-a');
    fs.mkdirSync(cwdA);

    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const logPath = path.join(base, 'prompts.jsonl');
    fs.writeFileSync(logPath, [
      'not json at all!!!',
      JSON.stringify({ ts: recentTs, cwd: cwdA, prompt: 'valid' }),
      '{ broken',
    ].join('\n') + '\n');

    const result = activeProjectCwds(90, { logPath });
    assert.equal(result.length, 1);
    assert.equal(result[0], cwdA);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
