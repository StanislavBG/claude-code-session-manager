/**
 * health-starve-escalation.test.cjs — `npm run health` must report
 * non-GREEN when any project has been starved (findStarvedProjects) past
 * the LATER escalation threshold (STARVE_ESCALATION_MS), naming the project
 * and the hold reason scheduler.cjs's runStarveEscalationSweep already
 * recorded on the matching 'project_starve_escalated' audit event — health
 * runs as its own cold process with no access to the live scheduler's
 * in-memory `lastTick`, so the durable audit-log.jsonl trail is the only
 * place that reason survives to be read from here.
 *
 * Exercises evaluateStarveEscalationHealth() and
 * latestStarveEscalationReasons() directly — pure/fs-scoped, matching every
 * other evaluate* helper's test pattern in this file (see
 * health-queue-dispatch.test.cjs's header). `project_starve_escalation` is
 * wired into health.cjs's `criticalComponents` gate, so `ok: false` here is
 * exactly what flips `npm run health`'s exit code from 0 to 1.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-starve-escalation.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  evaluateStarveEscalationHealth,
  latestStarveEscalationReasons,
} = require('../health.cjs');
const { STARVE_ESCALATION_MS } = require('../scheduler.cjs');

const CWD = '/home/bilko/Projects/Bilko';
const NOW = Date.parse('2026-09-12T20:00:00.000Z');
const idleFor = (ms) => NOW - ms;

test('a project starved past the escalation threshold is non-GREEN and names the project + hold reason', () => {
  const jobs = [{ slug: 'a', cwd: CWD, status: 'pending', createdAt: new Date(idleFor(STARVE_ESCALATION_MS + 60_000)).toISOString() }];
  // findStarvedProjects requires some OTHER project to be running — an idle
  // machine is not starvation, only a passed-over project is.
  const allJobs = [...jobs, { slug: 'other', cwd: '/home/bilko/Projects/other', status: 'running' }];
  const result = evaluateStarveEscalationHealth(allJobs, NOW, STARVE_ESCALATION_MS, { [CWD]: 'slots-exhausted' });
  expect(result.ok).toBe(false);
  expect(result.projects).toEqual([
    expect.objectContaining({ cwd: CWD, pendingCount: 1, holdReason: 'slots-exhausted' }),
  ]);
  expect(result.message).toMatch(new RegExp(CWD.replace(/\//g, '\\/')));
  expect(result.message).toMatch(/slots-exhausted/);
});

test('a starved project with no recorded escalation reason yet reports "unknown", not a throw', () => {
  const allJobs = [
    { slug: 'a', cwd: CWD, status: 'pending', createdAt: new Date(idleFor(STARVE_ESCALATION_MS + 1)).toISOString() },
    { slug: 'other', cwd: '/home/bilko/Projects/other', status: 'running' },
  ];
  const result = evaluateStarveEscalationHealth(allJobs, NOW, STARVE_ESCALATION_MS, {});
  expect(result.ok).toBe(false);
  expect(result.projects[0].holdReason).toBe('unknown');
});

test('a starve below the escalation threshold stays GREEN', () => {
  const allJobs = [
    { slug: 'a', cwd: CWD, status: 'pending', createdAt: new Date(idleFor(STARVE_ESCALATION_MS - 60_000)).toISOString() },
    { slug: 'other', cwd: '/home/bilko/Projects/other', status: 'running' },
  ];
  const result = evaluateStarveEscalationHealth(allJobs, NOW, STARVE_ESCALATION_MS, {});
  expect(result).toEqual({ ok: true });
});

test('nothing pending anywhere stays GREEN', () => {
  const result = evaluateStarveEscalationHealth([], NOW, STARVE_ESCALATION_MS, {});
  expect(result).toEqual({ ok: true });
});

test('latestStarveEscalationReasons reads the LAST recorded holdReason per cwd from the audit log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starve-health-audit-'));
  const auditPath = path.join(dir, 'audit-log.jsonl');
  const lines = [
    { kind: 'project_starved', cwd: CWD, ageMs: 1000 }, // different kind — must be ignored
    { kind: 'project_starve_escalated', cwd: CWD, holdReason: 'memory-deferred' },
    { kind: 'project_starve_escalated', cwd: CWD, holdReason: 'load-deferred' }, // latest wins
    { kind: 'project_starve_escalated', cwd: '/home/bilko/Projects/other', holdReason: 'held' },
  ];
  fs.writeFileSync(auditPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const reasons = latestStarveEscalationReasons(auditPath);
  expect(reasons[CWD]).toBe('load-deferred');
  expect(reasons['/home/bilko/Projects/other']).toBe('held');
});

test('latestStarveEscalationReasons returns {} for a missing audit log, never a throw', () => {
  expect(latestStarveEscalationReasons('/nonexistent/path/audit-log.jsonl')).toEqual({});
});
