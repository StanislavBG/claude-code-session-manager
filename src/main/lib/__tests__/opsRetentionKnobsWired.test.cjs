/**
 * opsRetentionKnobsWired.test.cjs — auditLogMonths / reservedMarkersKeep in
 * ops-retention.json are honored by audit-log rotation and PRD-number allocation.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/opsRetentionKnobsWired.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('../opsRetentionSettings.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');
const { allocateParallelGroup, _resetCache } = require('../../scheduler/prdParser.cjs');

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-knobs-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeRaw(text) {
  fs.mkdirSync(path.dirname(settings.storePath()), { recursive: true });
  fs.writeFileSync(settings.storePath(), text);
}

// Seed 8 rolled files + a live file last written in an older month, then rotate.
function rotate() {
  const dir = fs.mkdtempSync(path.join(home, 'audit-'));
  for (let m = 1; m <= 8; m += 1) fs.writeFileSync(path.join(dir, `audit-log-2025-${String(m).padStart(2, '0')}.jsonl.gz`), 'x');
  const target = path.join(dir, 'audit-log.jsonl');
  fs.writeFileSync(target, '{"a":1}\n');
  const old = new Date('2025-09-15T00:00:00Z');
  fs.utimesSync(target, old, old);
  appendAuditEvent('test', {}, { target, now: new Date('2025-10-15T00:00:00Z') });
  return fs.readdirSync(dir).filter((f) => /^audit-log-\d{4}-\d{2}\.jsonl\.gz$/.test(f));
}

async function allocAfterSeed() {
  const dir = fs.mkdtempSync(path.join(home, 'prds-'));
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  for (let i = 1; i <= 30; i += 1) {
    const f = path.join(dir, `.reserved-${i}`);
    fs.writeFileSync(f, '');
    fs.utimesSync(f, old, old);
  }
  _resetCache();
  await allocateParallelGroup(dir);
  return fs.readdirSync(dir).filter((n) => n.startsWith('.reserved-')).length;
}

test('auditLogMonths:2 keeps 2 rolled files', () => {
  writeRaw(JSON.stringify({ auditLogMonths: 2 }));
  expect(rotate()).toHaveLength(2);
});

test('reservedMarkersKeep:10 prunes to 10 old markers', async () => {
  writeRaw(JSON.stringify({ reservedMarkersKeep: 10 }));
  const n = await allocAfterSeed();
  // 10 kept old + the fresh marker from this allocation (<1h, never pruned)
  expect(n).toBeLessThanOrEqual(11);
  expect(n).toBeGreaterThanOrEqual(10);
});

test('corrupt settings file falls back to 6 / 100', async () => {
  writeRaw('{not json');
  expect(rotate()).toHaveLength(6);
  expect(await allocAfterSeed()).toBe(31);
});

test('planRecordsDays reaches the plan-records sweep with an epicStatus function', () => {
  const { runPlanRecordSweep } = require('../scheduler/runLogRetention.cjs');
  writeRaw(JSON.stringify({ planRecordsDays: 5 }));
  // Readable active-index fixture: the sweep fails closed (epicStatus throws) when the
  // index is unreadable — including a missing tmpdir cwd, which opsPath refuses as ephemeral.
  const proj = path.join(home, 'p');
  const sessionsDir = path.join(proj, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'active-index.json'), JSON.stringify({
    sessions: { live: { status: 'active', completedAt: null } },
  }));
  const calls = [];
  runPlanRecordSweep({ cwds: [proj], prune: (o) => { calls.push(o); return { removed: [], kept: 0 }; } });
  expect(calls).toHaveLength(1);
  expect(calls[0].days).toBe(5);
  expect(typeof calls[0].epicStatus).toBe('function');
  expect(calls[0].epicStatus('nope')).toBeNull();
  expect(calls[0].epicStatus('live')).toEqual({ status: 'active', completedAt: null });
});

test('planRecordsDays defaults to 14 on a corrupt settings file', () => {
  const { runPlanRecordSweep } = require('../scheduler/runLogRetention.cjs');
  writeRaw('{not json');
  const calls = [];
  runPlanRecordSweep({ cwds: [path.join(home, 'p')], prune: (o) => { calls.push(o); return { removed: [], kept: 0 }; } });
  expect(calls[0].days).toBe(14);
});
