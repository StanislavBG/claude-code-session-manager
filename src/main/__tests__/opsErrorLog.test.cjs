/**
 * opsErrorLog.test.cjs — appendError() is the sole writer of the `logs` ops
 * namespace (single-writer law, opsOwnership.cjs). Verifies: writes a tagged
 * JSONL line to <cwd>/session-manager-operations/logs/errors-<date>.jsonl,
 * redacts sensitive meta keys, and no-ops (never throws) with no cwd.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/opsErrorLog.test.cjs
 */

'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const opsErrorLog = require('../lib/telemetry/opsErrorLog.cjs');

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-opslog-test-'));
}

function readLines(cwd) {
  const dir = opsErrorLog.logsDir(cwd);
  const file = opsErrorLog.todayFile(cwd);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('appendError writes a tagged JSONL line', () => {
  const cwd = mkTmpProject();
  opsErrorLog.appendError({
    cwd,
    scope: 'pty',
    tabId: 'tab-123',
    tags: ['spawn-failed'],
    message: 'pty.spawn threw: boom',
  });
  const lines = readLines(cwd);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.level, 'error');
  assert.equal(line.scope, 'pty');
  assert.equal(line.tabId, 'tab-123');
  assert.equal(line.message, 'pty.spawn threw: boom');
  assert.ok(line.tags.includes('level:error'));
  assert.ok(line.tags.includes('scope:pty'));
  assert.ok(line.tags.includes('tab:tab-123'));
  assert.ok(line.tags.includes('spawn-failed'));
  assert.ok(typeof line.ts === 'string' && !Number.isNaN(Date.parse(line.ts)));
});

test('appendError redacts sensitive meta keys', () => {
  const cwd = mkTmpProject();
  opsErrorLog.appendError({
    cwd,
    scope: 'chatRunner',
    message: 'run failed',
    meta: { token: 'sk-secret', sessionId: 'abc', password: 'hunter2' },
  });
  const [line] = readLines(cwd);
  assert.equal(line.meta.token, '[redacted]');
  assert.equal(line.meta.password, '[redacted]');
  assert.equal(line.meta.sessionId, 'abc');
});

test('appendError is a no-op with no cwd', () => {
  // Must not throw, and there is nowhere to assert a file was NOT written
  // since no cwd means no path — this just proves it never throws.
  assert.doesNotThrow(() => opsErrorLog.appendError({ scope: 'x', message: 'y' }));
});

test('appendError merges caller tags without duplicating auto-derived ones', () => {
  const cwd = mkTmpProject();
  opsErrorLog.appendError({
    cwd,
    scope: 'chatRunner',
    tabId: 'tab-9',
    tags: ['level:error', 'silent-probe'], // deliberately duplicates an auto tag
    message: 'probe failed',
  });
  const [line] = readLines(cwd);
  const count = line.tags.filter((t) => t === 'level:error').length;
  assert.equal(count, 1);
  assert.ok(line.tags.includes('silent-probe'));
});

/** Resolve symlinks on the deepest existing ancestor so /tmp vs /private/tmp compare equal. */
function realOrResolved(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...tail.reverse()); } catch { /* walk up */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.push(path.basename(head));
    head = up;
  }
}

function isInsideRoot(child, root) {
  const rel = path.relative(realOrResolved(root), realOrResolved(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * A never-created "real project root" that sits outside os.tmpdir() and
 * SM_SANDBOX_DIR wherever this checkout lives. The repo's own root is NOT
 * usable: job/publish worktrees live under /tmp, where it counts as scratch.
 */
function outsideScratchProbe() {
  const roots = [os.tmpdir(), process.env.SM_SANDBOX_DIR].filter(Boolean);
  const name = `.sm-opslog-refusal-probe-${process.pid}-${Date.now()}`;
  const candidates = [path.join(os.homedir(), name), path.join(path.parse(process.cwd()).root, name)];
  const probe = candidates.find((c) => !fs.existsSync(c) && !roots.some((r) => isInsideRoot(c, r)));
  assert.ok(probe, `no probe cwd outside ${roots.join(', ')} among ${candidates.join(', ')}`);
  return { probe, roots };
}

test('under vitest, a real project root is refused: no file written, no telemetry', () => {
  const { probe, roots } = outsideScratchProbe();
  for (const r of roots) assert.equal(isInsideRoot(probe, r), false, `${probe} must sit outside ${r}`);
  assert.equal(fs.existsSync(probe), false);
  const telemetryPath = require.resolve('../lib/telemetry/telemetryClient.cjs');
  const saved = require.cache[telemetryPath];
  let reportErrorCalls = 0;
  let logLineCalls = 0;
  require.cache[telemetryPath] = {
    id: telemetryPath, filename: telemetryPath, loaded: true,
    exports: { reportError: () => { reportErrorCalls++; }, logLine: () => { logLineCalls++; } },
  };
  let existedAfter;
  try {
    opsErrorLog.appendError({ cwd: probe, scope: 'chatRunner', tabId: 'T', message: 'fixture' });
    opsErrorLog.appendError({ cwd: probe, scope: 'chatRunner', level: 'warn', message: 'fixture' });
    existedAfter = fs.existsSync(probe);
  } finally {
    if (saved) require.cache[telemetryPath] = saved; else delete require.cache[telemetryPath];
    if (fs.existsSync(probe)) fs.rmSync(probe, { recursive: true, force: true });
  }
  assert.equal(existedAfter, false, 'appendError must not create the refused cwd or its logs/');
  assert.equal(reportErrorCalls, 0);
  assert.equal(logLineCalls, 0);
});
