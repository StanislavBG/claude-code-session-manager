/**
 * scheduler-load-gate-last-resort.test.cjs — the starvation watchdog's bypass
 * (tickQueue({ bypassLoadGate, lastResort })) sends ONE job on a saturated CPU
 * and the whole batch otherwise. Separate file from scheduler-load-gate-tick
 * so the leftover running rows / slot claims of those tests cannot skew the
 * batch sizes asserted here.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-load-gate-last-resort.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');
const { settleScheduler } = require('../../../tests/helpers/schedulerSettle.cjs');

const PRD_BODY = '---\ntitle: Load gate PRD\ncreatedVia: scheduler-api\n---\n\nLoad gate PRD.\n';

let tmpHome;
let originalHome;
let originalWt;
let scheduler;
let createLoadGate;
let auditLogPath;

function makeProject(name) {
  const cwd = path.join(tmpHome, 'Projects', name);
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'fixture-epic', 'prds');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(prdsDir, { recursive: true });
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${name}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  return { cwd, prdsDir, queueFile: path.join(stateDir, 'queue.json') };
}

function queueOne(proj, slug) {
  fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: [{ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() }],
  }));
}

function gateWithCpu(busyFraction) {
  return createLoadGate({
    loadavg: () => [32.84, 25, 22],
    cores: () => 14,
    threshold: 0.85,
    cpu: { observe() {}, sample: () => ({ busyFraction, iowaitFraction: 0, windowMs: 61_000 }) },
  });
}

function readAuditKind(kind) {
  let lines;
  try {
    lines = fs.readFileSync(auditLogPath(), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

beforeAll(() => {
  originalHome = process.env.HOME;
  originalWt = process.env.SM_JOB_WORKTREE_DISABLE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-load-gate-tick-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  ({ createLoadGate } = require('../lib/scheduler/loadGate.cjs'));
  ({ auditLogPath } = require('../lib/telemetry/auditLog.cjs'));
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({ body: `
    require('fs').writeFileSync(require('path').join(process.cwd(), 'ran-here.marker'), 'yes');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok\\nSCHEDULER_VERDICT: PASS' }) + '\\n');
    process.exit(0);
  ` });
});

function anyRunning() {
  try {
    const projects = path.join(tmpHome, 'Projects');
    for (const name of fs.readdirSync(projects)) {
      const qf = path.join(projects, name, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
      try {
        const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
        if ((q.jobs || []).some((j) => j.status === 'running')) return true;
      } catch { /* missing or mid-write */ }
    }
  } catch { /* no projects dir */ }
  return false;
}

afterEach(() => settleScheduler({ scheduler, projectsDir: path.join(tmpHome, 'Projects') }));

afterAll(async () => {
  // A stub job may still be finalizing; removing HOME under it prints ENOENT noise.
  for (let i = 0; i < 100 && anyRunning(); i += 1) await new Promise((r) => setTimeout(r, 50));
  process.env.HOME = originalHome;
  if (originalWt === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalWt;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_BIN;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});


// Starvation watchdog (lastResort) bypass: one job only on a saturated CPU.
async function twoRowBypassTick(name, gate, tickOpts) {
  const slots = require('../lib/scheduler/sessionSlots.cjs');
  for (let i = 0; i < 100 && (anyRunning() || slots.inUse() > 0); i += 1) await new Promise((r) => setTimeout(r, 50));
  const proj = makeProject(name);
  const slugs = [`9301-${name}-a-${process.pid}`, `9301-${name}-b-${process.pid}`];
  for (const slug of slugs) fs.writeFileSync(path.join(proj.prdsDir, `${slug}.md`), PRD_BODY, 'utf8');
  fs.writeFileSync(proj.queueFile, JSON.stringify({
    jobs: slugs.map((slug) => ({ slug, title: slug, status: 'pending', cwd: proj.cwd, dependsOn: [], createdAt: new Date().toISOString() })),
  }));
  const before = readAuditKind('load_gate_last_resort').length;
  scheduler._setLoadGateForTests(gate);
  const result = await scheduler.tickQueue(tickOpts);
  // spawnJob is fire-and-forget: wait for this project's launched rows to leave 'pending'.
  // Count only this project's own rows: a stray pending row elsewhere may also launch.
  const want = result.fired ? Math.min(result.count, 2) : 0;
  let pending = 2;
  for (let i = 0; i < 50 && pending > 2 - want; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    pending = JSON.parse(fs.readFileSync(proj.queueFile, 'utf8')).jobs.filter((j) => j.status === 'pending').length;
  }
  const launched = 2 - pending;
  // Let launched stub jobs finish so they cannot rewrite the queue after the cleanup below.
  for (let i = 0; i < 100 && (anyRunning() || slots.inUse() > 0); i += 1) await new Promise((r) => setTimeout(r, 50));
  // Drop held rows so they do not inflate the next test's batch.
  const q = JSON.parse(fs.readFileSync(proj.queueFile, 'utf8'));
  fs.writeFileSync(proj.queueFile, JSON.stringify({ ...q, jobs: q.jobs.filter((j) => j.status !== 'pending') }));
  return { result, pending, launched, newRows: readAuditKind('load_gate_last_resort').slice(before) };
}

test('lastResort bypass on a saturated CPU launches one job and audits load_gate_last_resort', async () => {
  const { result, pending, newRows } = await twoRowBypassTick('lr-sat', gateWithCpu(0.95), { bypassLoadGate: true, lastResort: true });
  expect(result.fired).toBe(true);
  expect(result.count).toBe(1);
  expect(newRows.length).toBe(1);
  expect(newRows[0].stillHeld.length).toBe(1);
  expect(pending).toBe(1);
}, 120_000);

test('a human bypass (no lastResort) on a saturated CPU keeps the whole batch', async () => {
  const { launched, newRows } = await twoRowBypassTick('hu-sat', gateWithCpu(0.95), { bypassLoadGate: true });
  expect(launched).toBe(2);
  expect(newRows.length).toBe(0);
}, 120_000);

test('lastResort bypass at 60% busy keeps the whole batch', async () => {
  const { launched, newRows } = await twoRowBypassTick('lr-60', gateWithCpu(0.6), { bypassLoadGate: true, lastResort: true });
  expect(launched).toBe(2);
  expect(newRows.length).toBe(0);
}, 120_000);

test('lastResort bypass with no CPU sample keeps the whole batch', async () => {
  const gate = createLoadGate({
    loadavg: () => [32.84, 25, 22], cores: () => 14, threshold: 0.85,
    cpu: { observe() {}, sample: () => null },
  });
  const { launched, newRows } = await twoRowBypassTick('lr-null', gate, { bypassLoadGate: true, lastResort: true });
  expect(launched).toBe(2);
  expect(newRows.length).toBe(0);
}, 120_000);
