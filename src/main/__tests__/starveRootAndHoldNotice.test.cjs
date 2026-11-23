/**
 * starveRootAndHoldNotice.test.cjs — starvation events name the ROOT
 * blocker (the row everything waits on) and its reason; a project whose
 * blocked rows all wait on preflight-held roots is a known wait (no
 * project_starved / project_starve_escalated); a preflight hold sends ONE
 * informational Epic notice the moment it first arms; scheduler_list_prds
 * rows carry heldReason + waitingOn.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/starveRootAndHoldNotice.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'starve-root-hold-'));
process.env.HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

let sched;
let auditLogPath;
let STARVE_ESCALATION_MS;
let buildPreflightHoldNotice;

beforeAll(() => {
  sched = require('../scheduler.cjs');
  ({ auditLogPath } = require('../lib/telemetry/auditLog.cjs'));
  ({ STARVE_ESCALATION_MS } = require('../scheduler/starvation.cjs'));
  ({ buildPreflightHoldNotice } = require('../lib/scheduler/reviewNotice.cjs'));
});

afterAll(() => {
  sched._setPreflightHoldNoticeSenderForTests(null);
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readAuditKind(kind) {
  let lines;
  try { lines = fs.readFileSync(auditLogPath(), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  return lines.map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isCrashed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

beforeEach(() => {
  fs.mkdirSync(path.dirname(auditLogPath()), { recursive: true });
  fs.writeFileSync(auditLogPath(), '');
  sched.attachWindow(null);
  sched._resetPreflightHoldNoticesForTests();
});

const row = (cwd, slug, status, extra = {}) => ({ slug, cwd, epicId: 'e1', status, ...extra });

function parkedChain(cwd) {
  return [
    row(cwd, '852-fix-profile', 'needs_review', {
      statusHistory: [{ from: 'running', to: 'needs_review', reason: 'gate red: asc profile missing', source: 's', at: '2' }],
    }),
    row(cwd, '853-signing', 'pending', { dependsOn: ['852-fix-profile'] }),
    row(cwd, '854-build', 'pending', { dependsOn: ['853-signing'] }),
  ];
}

function heldChain(cwd) {
  return [
    row(cwd, '10-root', 'pending', {
      preflight: 'test -f creds',
      heldReason: 'waiting on precondition: test -f creds exited 1 — re-check at x',
      preflightHold: { since: '2026-11-22T00:00:00.000Z', attempts: 1, nextAt: new Date(Date.now() + 600_000).toISOString() },
    }),
    row(cwd, '11-mid', 'pending', { dependsOn: ['10-root'] }),
    row(cwd, '12-leaf', 'pending', { dependsOn: ['11-mid'] }),
  ];
}

test('project_starve_escalated + toast name the root blocker slug, status and reason', () => {
  const cwd = '/proj/root-fields';
  const win = fakeWindow();
  sched.attachWindow(win);
  const sp = { cwd, pendingCount: 2, oldestPendingSlug: '854-build', ageMs: STARVE_ESCALATION_MS + 60_000 };
  sched.runStarveEscalationSweep([sp], parkedChain(cwd));
  const evs = readAuditKind('project_starve_escalated');
  expect(evs).toHaveLength(1);
  expect(evs[0].rootBlockingSlug).toBe('852-fix-profile');
  expect(evs[0].rootBlockingStatus).toBe('needs_review');
  expect(evs[0].rootBlockingReason).toBe('gate red: asc profile missing');
  expect(win.sent).toHaveLength(1);
  expect(win.sent[0].channel).toBe('schedule:stall');
  expect(win.sent[0].payload.message).toContain('852-fix-profile');
  expect(win.sent[0].payload.message).toContain('gate red: asc profile missing');
});

test('project_starved carries the root blocker fields', () => {
  const cwd = '/proj/root-starved';
  const sp = { cwd, pendingCount: 2, oldestPendingSlug: '854-build', ageMs: 1 };
  sched.reportStarvedProjects([sp], parkedChain(cwd));
  const evs = readAuditKind('project_starved');
  expect(evs).toHaveLength(1);
  expect(evs[0]).toMatchObject({
    cwd, pendingCount: 2, oldestPendingSlug: '854-build',
    rootBlockingSlug: '852-fix-profile', rootBlockingStatus: 'needs_review', rootBlockingReason: 'gate red: asc profile missing',
  });
});

test('every blocked row waits on a preflight-held root → no project_starved, no escalation', () => {
  const cwd = '/proj/known-wait';
  const win = fakeWindow();
  sched.attachWindow(win);
  const sp = { cwd, pendingCount: 3, oldestPendingSlug: '12-leaf', ageMs: STARVE_ESCALATION_MS + 60_000 };
  sched.reportStarvedProjects([sp], heldChain(cwd));
  sched.runStarveEscalationSweep([sp], heldChain(cwd));
  expect(readAuditKind('project_starved')).toHaveLength(0);
  expect(readAuditKind('project_starve_escalated')).toHaveLength(0);
  expect(win.sent).toHaveLength(0);
});

test('a project with a preflight-held root AND a parked root still reports', () => {
  const cwd = '/proj/mixed';
  const rows = [...heldChain(cwd), ...parkedChain(cwd)];
  const sp = { cwd, pendingCount: 4, oldestPendingSlug: '854-build', ageMs: 1 };
  sched.reportStarvedProjects([sp], rows);
  const evs = readAuditKind('project_starved');
  expect(evs).toHaveLength(1);
  expect(evs[0].rootBlockingSlug).toBe('852-fix-profile');
});

// ---- preflight hold notice ----

function queuePath(projectCwd) {
  return path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
}

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function mkProject(rows) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hold-notice-'));
  registerActiveProject(projectCwd);
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'epic-hold', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  for (const r of rows) {
    fs.writeFileSync(path.join(prdsDir, `${r.slug}.md`), `---\ntitle: ${r.slug}\ncwd: ${projectCwd}\n${r.preflight ? `preflight: ${JSON.stringify(r.preflight)}\n` : ''}${r.dependsOn ? `dependsOn: [${r.dependsOn.join(', ')}]\n` : ''}---\n# Goal\nx\n`, 'utf8');
  }
  fs.mkdirSync(path.dirname(queuePath(projectCwd)), { recursive: true });
  fs.writeFileSync(queuePath(projectCwd), JSON.stringify({
    jobs: rows.map((r) => ({ status: 'pending', cwd: projectCwd, agentType: 'dev-lead', epicId: 'epic-hold', ...r })),
  }, null, 2));
  return projectCwd;
}

function readRow(projectCwd, slug) {
  return JSON.parse(fs.readFileSync(queuePath(projectCwd), 'utf8')).jobs.find((j) => j.slug === slug);
}

test('first hold arm sends ONE buildPreflightHoldNotice at once; re-check failures send nothing more', async () => {
  const tag = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const root = `3749-root-${tag}`;
  const mid = `3749-mid-${tag}`;
  const leaf = `3749-leaf-${tag}`;
  const preflight = 'node -e "process.exit(4)"';
  const projectCwd = mkProject([
    { slug: root, preflight },
    { slug: mid, dependsOn: [root] },
    { slug: leaf, dependsOn: [mid] },
  ]);
  const calls = [];
  sched._setPreflightHoldNoticeSenderForTests(async (...args) => { calls.push(args); return { ok: true }; });
  try {
    await sched.runPreflightGate({ slug: root, cwd: projectCwd, preflight, epicId: 'epic-hold', status: 'pending' }, projectCwd);
    const r1 = readRow(projectCwd, root);
    expect(r1.preflightHold.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    const [cwdArg, epicArg, text, meta] = calls[0];
    expect(cwdArg).toBe(projectCwd);
    expect(epicArg).toBe('epic-hold');
    expect(text).toBe(buildPreflightHoldNotice({
      slug: root,
      failText: r1.preflightHold.failText,
      preflight,
      heldSlugs: [root, mid, leaf],
      nextAt: r1.preflightHold.nextAt,
    }));
    expect(meta.prdSlug).toBe(root);
    expect(meta.notice).toBe('preflight-hold');
    expect(meta.outcome).toBeUndefined();
    expect(text).not.toContain('SM_NEEDS_INPUT');

    // Same hold re-armed at attempts === 1 (dedup by key) → nothing.
    await sched.sendPreflightHoldNotice({ slug: root, cwd: projectCwd, preflight, epicId: 'epic-hold' }, r1.preflightHold, [r1]);
    expect(calls).toHaveLength(1);

    // A due re-check that fails again climbs to attempts 2 → nothing more.
    await sched.runPreflightGate({ ...r1, preflightHold: { ...r1.preflightHold, nextAt: new Date(Date.now() - 1000).toISOString() } }, projectCwd);
    expect(readRow(projectCwd, root).preflightHold.attempts).toBe(2);
    expect(calls).toHaveLength(1);
  } finally {
    sched._setPreflightHoldNoticeSenderForTests(null);
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
}, 60_000);

test('scheduler_list_prds rows carry heldReason and waitingOn (root blocker slug)', async () => {
  const tag = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const root = `3749-lroot-${tag}`;
  const mid = `3749-lmid-${tag}`;
  const leaf = `3749-lleaf-${tag}`;
  const heldReason = 'waiting on precondition: test -f creds exited 1 — re-check at x';
  const projectCwd = mkProject([
    { slug: root, preflight: 'test -f creds', heldReason, preflightHold: { since: '2026-11-22T00:00:00.000Z', attempts: 1, nextAt: new Date(Date.now() + 600_000).toISOString() } },
    { slug: mid, dependsOn: [root] },
    { slug: leaf, dependsOn: [mid] },
  ]);
  try {
    const { prds } = await sched.remote.listPrds({ cwd: projectCwd, limit: 500 });
    const bySlug = new Map(prds.map((p) => [p.slug, p]));
    expect(bySlug.get(root).heldReason).toBe(heldReason);
    expect(bySlug.get(root).waitingOn ?? null).toBeNull();
    expect(bySlug.get(mid).waitingOn).toBe(root);
    expect(bySlug.get(leaf).waitingOn).toBe(root);
    expect(bySlug.get(leaf).heldReason ?? null).toBeNull();
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
}, 60_000);
