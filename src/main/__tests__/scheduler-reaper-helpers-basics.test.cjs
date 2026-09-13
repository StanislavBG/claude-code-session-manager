'use strict';

// Ported from the retired top-level test-root directory (a node:test suite,
// never runnable by this repo's vitest-only setup — see CLAUDE.md's Commands
// section). The existing src/main/lib/__tests__/reaperHelpers.test.cjs
// exercises classifyRunOutcome extensively via selectReapableJobs and the
// rate-limit paths, but never asserts claudePidAlive directly (only ever
// injects a stand-in `pidAlive` function), and never pins the bare
// no-result/empty-file/malformed-event edge cases below. These fill that
// gap.
//
// Run: timeout 120 npx vitest run src/main/__tests__/scheduler-reaper-helpers-basics.test.cjs

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { claudePidAlive, classifyRunOutcome } = require('../lib/reaperHelpers.cjs');

// ─────────────────────────────────────────── claudePidAlive

test('claudePidAlive: nonexistent pid (999999) returns false', () => {
  assert.equal(claudePidAlive(999999), false);
});

test('claudePidAlive: pid 0 returns false', () => {
  assert.equal(claudePidAlive(0), false);
});

test('claudePidAlive: pid 1 returns false', () => {
  assert.equal(claudePidAlive(1), false);
});

test('claudePidAlive: null returns false', () => {
  assert.equal(claudePidAlive(null), false);
});

test('claudePidAlive: undefined returns false', () => {
  assert.equal(claudePidAlive(undefined), false);
});

// ─────────────────────────────────────────── classifyRunOutcome

function writeTempLog(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-basics-test-'));
  const filePath = path.join(dir, 'test.log');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('classifyRunOutcome: success without an is_error field → success', () => {
  const p = writeTempLog('{"type":"result","subtype":"success","result":"ok"}\n');
  assert.equal(classifyRunOutcome(p), 'success');
});

test('classifyRunOutcome: subtype success but is_error:true → failed (error wins)', () => {
  const p = writeTempLog('{"type":"result","subtype":"success","is_error":true}\n');
  assert.equal(classifyRunOutcome(p), 'failed');
});

test('classifyRunOutcome: no result event in the tail → no_result', () => {
  const log = [
    '{"type":"assistant","message":"working"}',
    '{"type":"tool_use","name":"bash"}',
    'some plain text log line',
  ].join('\n');
  const p = writeTempLog(log);
  assert.equal(classifyRunOutcome(p), 'no_result');
});

test('classifyRunOutcome: empty file → no_result', () => {
  const p = writeTempLog('');
  assert.equal(classifyRunOutcome(p), 'no_result');
});

test('classifyRunOutcome: last result event wins when multiple exist', () => {
  const log = [
    '{"type":"result","subtype":"success"}',
    '{"type":"result","subtype":"error","is_error":true}',
  ].join('\n');
  const p = writeTempLog(log);
  assert.equal(classifyRunOutcome(p), 'failed');
});

test('classifyRunOutcome: nonexistent file → no_result (readTail swallows I/O errors)', () => {
  assert.equal(classifyRunOutcome('/nonexistent/path/that/cannot/exist.log'), 'no_result');
});
