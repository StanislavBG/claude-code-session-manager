'use strict';

// Run: timeout 120 node --test scripts/__tests__/watchdog-helpers.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { heartbeatFresh } = require('../lib/watchdogHelpers.cjs');

function tmpFile() {
  return path.join(os.tmpdir(), `watchdog-test-${process.pid}-${Math.floor(Math.random() * 1e9)}.log`);
}

function writeLines(p, lines) {
  fs.writeFileSync(p, lines.join('\n') + '\n');
}

test('fresh ts (just now) → true', () => {
  const p = tmpFile();
  try {
    writeLines(p, [JSON.stringify({ ts: Date.now(), counts: {}, paused: null })]);
    assert.equal(heartbeatFresh(p, 180_000), true);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('stale ts (10 min old) → false', () => {
  const p = tmpFile();
  try {
    const staleTs = Date.now() - 10 * 60 * 1000;
    writeLines(p, [JSON.stringify({ ts: staleTs, counts: {}, paused: null })]);
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('missing file → false', () => {
  const p = path.join(os.tmpdir(), 'watchdog-test-nonexistent-999999.log');
  assert.equal(heartbeatFresh(p, 180_000), false);
});

test('garbage last line → false', () => {
  const p = tmpFile();
  try {
    writeLines(p, ['not json at all!!!']);
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('last non-empty line wins (fresh after stale)', () => {
  const p = tmpFile();
  try {
    const staleTs = Date.now() - 10 * 60 * 1000;
    writeLines(p, [
      JSON.stringify({ ts: staleTs }),
      JSON.stringify({ ts: Date.now() }),
    ]);
    assert.equal(heartbeatFresh(p, 180_000), true);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('empty file → false', () => {
  const p = tmpFile();
  try {
    fs.writeFileSync(p, '');
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});

test('JSON line without ts field → false', () => {
  const p = tmpFile();
  try {
    writeLines(p, [JSON.stringify({ counts: {}, paused: null })]);
    assert.equal(heartbeatFresh(p, 180_000), false);
  } finally {
    try { fs.unlinkSync(p); } catch {}
  }
});
