/**
 * toolClearance.test.cjs — ma-confirm-clearance-resume: approving a tool-risk
 * 'confirm' request emits human.tool_confirmation, grants ONE clearance bound
 * to the args digest and resumes the SAME Claude session; denying emits
 * human.tool_confirmation { approved: false } and parks the job
 * confirmation_denied. The guard lets exactly one matching call through and
 * refuses a different-args replay, a second use, and an expired clearance.
 *
 * Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/toolClearance.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const marksLib = require('../../claude/toolRiskMarks.cjs');
const toolClearance = require('../toolClearance.cjs');
const { decide } = require('../../../../../scripts/hooks/lib/guard-tool-risk-policy.cjs');

let tmp;
let prevHome;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-clearance-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = path.join(tmp, 'sm-home');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SLUG = '3809-test-job';
const SESSION = '11111111-2222-3333-4444-555555555555';

function fixture() {
  const homeDir = path.join(tmp, 'home');
  const projectRoot = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'tool-risk.json'),
    JSON.stringify({ version: 1, marks: { 'Bash(npm publish:*)': 'confirm' } }));
  const requestsFile = path.join(tmp, 'sm-home', marksLib.CONFIRMATION_REQUESTS_FILE);
  return { homeDir, projectRoot, requestsFile };
}

const env = (f) => ({ SM_SCHEDULER_JOB_SLUG: SLUG, SM_SCHEDULER_JOB_EPIC_ID: 'epic-abc', SM_PROJECT_ROOT: f.projectRoot });
const decisionOf = (r) => (r.hookSpecificOutput ? r.hookSpecificOutput.permissionDecision : 'allow');
const publish = (cmd = 'npm publish --tag latest') => ({
  tool_name: 'Bash', tool_input: { command: cmd }, session_id: SESSION,
});

function deps() {
  const calls = { emit: [], resume: [], park: [] };
  return {
    calls,
    emit: (e) => { calls.emit.push(e); },
    resume: (r) => { calls.resume.push(r); },
    park: (p) => { calls.park.push(p); },
  };
}

// ── clearance store ─────────────────────────────────────────────────────────

test('grant + consume: one use only; the second use is refused', () => {
  const digest = marksLib.argsDigest({ command: 'npm publish' });
  const g = toolClearance.grantClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: digest, ttlMs: 60_000 });
  expect(g.expiresAt).toBeGreaterThan(Date.now());
  const first = toolClearance.consumeClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: digest });
  expect(first.ok).toBe(true);
  expect(first.clearance.argsDigest).toBe(digest);
  const second = toolClearance.consumeClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: digest });
  expect(second).toEqual({ ok: false, reason: 'none' });
});

test('expired: a clearance past its ttl is refused and removed', () => {
  const digest = marksLib.argsDigest({ command: 'npm publish' });
  const now = 1_000_000;
  toolClearance.grantClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: digest, ttlMs: 1000, now });
  const r = toolClearance.consumeClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: digest, now: now + 1001 });
  expect(r).toEqual({ ok: false, reason: 'expired' });
  expect(toolClearance.consumeClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: digest, now })).toEqual({ ok: false, reason: 'none' });
  // pruneExpired drops stale grants without consuming live ones.
  toolClearance.grantClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: 'a'.repeat(64), ttlMs: 1000, now });
  toolClearance.grantClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: 'b'.repeat(64), ttlMs: 10_000, now });
  expect(toolClearance.pruneExpired({ now: now + 5000 })).toBe(1);
  expect(toolClearance.consumeClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: 'b'.repeat(64), now: now + 5000 }).ok).toBe(true);
});

test('a clearance is bound to its job, tool and project', () => {
  const digest = marksLib.argsDigest({ command: 'npm publish' });
  toolClearance.grantClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: digest });
  expect(toolClearance.consumeClearance({ cwd: '/p', jobSlug: 'other-job', tool: 'Bash', argsDigest: digest }).ok).toBe(false);
  expect(toolClearance.consumeClearance({ cwd: '/p', jobSlug: SLUG, tool: 'mcp__x__y', argsDigest: digest }).ok).toBe(false);
  expect(toolClearance.consumeClearance({ cwd: '/elsewhere', jobSlug: SLUG, tool: 'Bash', argsDigest: digest })).toEqual({ ok: false, reason: 'mismatch' });
});

test('grantClearance validates its input', () => {
  expect(() => toolClearance.grantClearance({ cwd: '/p', jobSlug: SLUG, tool: 'Bash', argsDigest: 'nope' })).toThrow(/argsDigest/);
  expect(() => toolClearance.grantClearance({ cwd: '/p', jobSlug: '', tool: 'Bash', argsDigest: 'a'.repeat(64) })).toThrow(/jobSlug/);
});

// ── end to end through the guard ────────────────────────────────────────────

test('approve: emits human.tool_confirmation, grants, resumes the SAME session; guard allows exactly one matching call', () => {
  const f = fixture();
  const denied = decide(publish(), env(f), { homeDir: f.homeDir });
  expect(decisionOf(denied)).toBe('deny');
  const pending = toolClearance.listPendingConfirmations();
  expect(pending).toHaveLength(1);
  const request = pending[0].requests[0];
  expect(request).toMatchObject({ jobSlug: SLUG, tool: 'Bash', sessionId: SESSION, cwd: f.projectRoot });

  const d = deps();
  const out = toolClearance.answerConfirmation({ request, approved: true }, d);
  expect(out.action).toBe('resume');
  expect(d.calls.emit).toEqual([expect.objectContaining({
    kind: 'human.tool_confirmation', approved: true, tool: 'Bash', argsDigest: request.argsDigest, jobSlug: SLUG,
  })]);
  expect(d.calls.resume).toEqual([{ jobSlug: SLUG, sessionId: SESSION, request }]);
  expect(d.calls.park).toEqual([]);

  // Different-args replay is refused (and asks again) — the clearance is untouched.
  expect(decisionOf(decide(publish('npm publish --tag next'), env(f), { homeDir: f.homeDir }))).toBe('deny');
  // The exact approved call runs once…
  expect(decisionOf(decide(publish(), env(f), { homeDir: f.homeDir }))).toBe('allow');
  // …and a second use is refused.
  expect(decisionOf(decide(publish(), env(f), { homeDir: f.homeDir }))).toBe('deny');
});

test('deny: emits human.tool_confirmation { approved: false }, parks confirmation_denied, grants nothing', () => {
  const f = fixture();
  decide(publish(), env(f), { homeDir: f.homeDir });
  const request = toolClearance.listPendingConfirmations()[0].requests[0];
  const d = deps();
  const out = toolClearance.answerConfirmation({ request, approved: false }, d);
  expect(out.action).toBe('park');
  expect(d.calls.emit).toEqual([expect.objectContaining({ kind: 'human.tool_confirmation', approved: false, jobSlug: SLUG })]);
  expect(d.calls.park).toEqual([{ jobSlug: SLUG, reason: 'confirmation_denied', request }]);
  expect(d.calls.resume).toEqual([]);
  expect(decisionOf(decide(publish(), env(f), { homeDir: f.homeDir }))).toBe('deny');
});

test('pending confirmations: one record per (tool, digest), taken once', () => {
  const f = fixture();
  decide(publish(), env(f), { homeDir: f.homeDir });
  decide(publish(), env(f), { homeDir: f.homeDir });
  const pending = toolClearance.listPendingConfirmations();
  expect(pending).toHaveLength(1);
  expect(pending[0].requests).toHaveLength(1);
  const taken = toolClearance.takePendingConfirmation(pending[0].key);
  expect(taken && taken.requests).toHaveLength(1);
  expect(toolClearance.takePendingConfirmation(pending[0].key)).toBeNull();
  expect(toolClearance.listPendingConfirmations()).toEqual([]);
});
