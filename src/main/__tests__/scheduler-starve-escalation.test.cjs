/**
 * scheduler-starve-escalation.test.cjs — the `project_starved` audit event
 * (scheduler.cjs ~line 8888) used to be emit-only: it fired every sweep
 * forever with zero consequence. The 2026-09-12 audit log showed
 * /home/bilko/Projects/Bilko emitting it ~115 times over a 19h starve with
 * nothing acting on it. runStarveEscalationSweep is the bounded, automated
 * consequence: a starve outliving STARVE_ESCALATION_MS gets a DISTINCT
 * 'project_starve_escalated' audit event (once per starve stretch, latched
 * per cwd) plus a toast-channel error via the existing 'schedule:stall'
 * push (already wired to toast.error on the renderer side).
 *
 * Exercises selectStarveEscalations() (pure) directly, and
 * runStarveEscalationSweep() (the side-effecting wrapper) against a real,
 * scratch audit-log.jsonl and a fake attached window — matching
 * queue-starvation-per-project.test.cjs's pattern of setting HOME before
 * require() since every state path is baked from os.homedir() at load.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-starve-escalation.test.cjs
 */

'use strict';

import { test, beforeEach } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'starve-escalation-test-'));

const {
  selectStarveEscalations,
  runStarveEscalationSweep,
  STARVE_ESCALATION_MS,
  attachWindow,
} = require('../scheduler.cjs');
const { AUDIT_LOG_PATH } = require('../lib/auditLog.cjs');

const CWD_A = '/home/bilko/Projects/Bilko';
const CWD_B = '/home/bilko/Projects/session-manager';

function readAuditKind(kind) {
  let lines;
  try {
    lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

beforeEach(() => {
  // Fresh scratch audit log per test so escalation counts never bleed across
  // tests in this file.
  fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
  fs.writeFileSync(AUDIT_LOG_PATH, '');
  attachWindow(null);
});

test('selectStarveEscalations: escalates a row past threshold not already latched', () => {
  const starved = [{ cwd: CWD_A, pendingCount: 3, oldestPendingSlug: 'x', ageMs: STARVE_ESCALATION_MS + 1 }];
  const { toEscalate, toClear } = selectStarveEscalations(starved, new Set(), STARVE_ESCALATION_MS);
  assert.equal(toEscalate.length, 1);
  assert.equal(toEscalate[0].cwd, CWD_A);
  assert.deepEqual(toClear, []);
});

test('selectStarveEscalations: never re-escalates a cwd already latched', () => {
  const starved = [{ cwd: CWD_A, pendingCount: 3, oldestPendingSlug: 'x', ageMs: STARVE_ESCALATION_MS + 60_000 }];
  const { toEscalate } = selectStarveEscalations(starved, new Set([CWD_A]), STARVE_ESCALATION_MS);
  assert.deepEqual(toEscalate, []);
});

test('selectStarveEscalations: a latched cwd no longer starved is returned for latch-clear', () => {
  const { toEscalate, toClear } = selectStarveEscalations([], new Set([CWD_A]), STARVE_ESCALATION_MS);
  assert.deepEqual(toEscalate, []);
  assert.deepEqual(toClear, [CWD_A]);
});

test('selectStarveEscalations: below-threshold starve is neither escalated nor cleared', () => {
  const starved = [{ cwd: CWD_A, pendingCount: 1, oldestPendingSlug: 'x', ageMs: STARVE_ESCALATION_MS - 1 }];
  const { toEscalate, toClear } = selectStarveEscalations(starved, new Set(), STARVE_ESCALATION_MS);
  assert.deepEqual(toEscalate, []);
  assert.deepEqual(toClear, []);
});

test('runStarveEscalationSweep: emits project_starve_escalated exactly once per starve stretch, plus a toast', () => {
  const win = fakeWindow();
  attachWindow(win);
  const sp = { cwd: CWD_A, pendingCount: 4, oldestPendingSlug: 'oldest-a', ageMs: STARVE_ESCALATION_MS + 60_000 };

  runStarveEscalationSweep([sp]);
  assert.equal(readAuditKind('project_starve_escalated').length, 1);
  assert.equal(win.sent.length, 1);
  assert.equal(win.sent[0].channel, 'schedule:stall');
  assert.match(win.sent[0].payload.message, /Bilko/);

  const record = readAuditKind('project_starve_escalated')[0];
  assert.equal(record.cwd, CWD_A);
  assert.equal(record.pendingCount, 4);
  assert.equal(record.oldestPendingSlug, 'oldest-a');
  assert.equal(record.ageMs, sp.ageMs);
  assert.ok(
    ['slots-exhausted', 'memory-deferred', 'load-deferred', 'held', 'unknown'].includes(record.holdReason),
    `unexpected holdReason: ${record.holdReason}`,
  );

  // Same still-starved stretch on the NEXT sweep must not escalate again.
  runStarveEscalationSweep([sp]);
  assert.equal(readAuditKind('project_starve_escalated').length, 1);
  assert.equal(win.sent.length, 1);
});

test('runStarveEscalationSweep: the latch resets once the starve clears, so a later stretch escalates again', () => {
  const win = fakeWindow();
  attachWindow(win);
  const sp = { cwd: CWD_B, pendingCount: 2, oldestPendingSlug: 'oldest-b', ageMs: STARVE_ESCALATION_MS + 1 };

  runStarveEscalationSweep([sp]);
  assert.equal(readAuditKind('project_starve_escalated').length, 1);

  // Starve clears: this cwd is no longer reported by findStarvedProjects at all.
  runStarveEscalationSweep([]);
  assert.equal(readAuditKind('project_starve_escalated').length, 1); // no new escalation on a clear pass

  // A NEW starve stretch on the same cwd must escalate again — the latch
  // must not have been permanently burned by the first stretch.
  runStarveEscalationSweep([sp]);
  assert.equal(readAuditKind('project_starve_escalated').length, 2);
  assert.equal(win.sent.length, 2);
});
