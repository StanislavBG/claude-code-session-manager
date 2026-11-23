/**
 * preflightDispatchHold.test.cjs — a PRD `preflight` command gates dispatch.
 * Red → row stays pending with a preflightHold (no claude -p run, no
 * worktree); a due re-check that passes clears the hold and dispatches;
 * the picker skips a not-yet-due held row; a dependent waits on a held root;
 * reset clears the hold; rows without preflight are unaffected.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/preflightDispatchHold.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const claudeStub = require('../../../tests/helpers/claudeStub.cjs');

let tmpHome;
let originalHome;
let sched;
let jobWorktree;
let pickNextBatch;

const MIN = 60_000;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function registerActiveProject(cwd) {
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

function queuePath(projectCwd) {
  return path.join(projectCwd, 'session-manager-operations', 'scheduler', 'state', 'queue.json');
}

function mkProject(rows) {
  const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-preflight-hold-'));
  initRepo(projectCwd);
  registerActiveProject(projectCwd);
  const prdsDir = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  for (const r of rows) {
    const fm = r.preflight ? `---\npreflight: ${JSON.stringify(r.preflight)}\n---\n` : '';
    fs.writeFileSync(path.join(prdsDir, `${r.slug}.md`), `${fm}Preflight test.`, 'utf8');
  }
  fs.mkdirSync(path.dirname(queuePath(projectCwd)), { recursive: true });
  fs.writeFileSync(queuePath(projectCwd), JSON.stringify({
    jobs: rows.map((r) => ({ status: 'pending', cwd: projectCwd, agentType: 'dev-lead', ...r })),
  }, null, 2));
  return projectCwd;
}

function readRow(projectCwd, slug) {
  return JSON.parse(fs.readFileSync(queuePath(projectCwd), 'utf8')).jobs.find((j) => j.slug === slug);
}

function runDirFor(runId) {
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function auditEvents(type) {
  const dir = path.join(tmpHome, '.claude', 'session-manager');
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/audit.*\.jsonl$/.test(e.name)) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const ev = JSON.parse(line); if (ev.type === type || ev.event === type || ev.kind === type) out.push(ev); } catch { /* skip */ }
        }
      }
    }
  };
  walk(dir);
  return out;
}

function uniq(tag) {
  return `3747-${tag}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
}

// The claude stub drops a marker file in its cwd so "a run was launched" is observable.
function stubWithMarker() {
  process.env.SM_CLAUDE_BIN = claudeStub.writeClaudeStub({
    allowCommitUnder: os.tmpdir(),
    body: "require('fs').writeFileSync(require('path').join(process.cwd(), 'ran-here.marker'), 'x'); process.exit(0);",
  });
}

function launched(slug, projectCwd) {
  if (fs.existsSync(path.join(projectCwd, 'ran-here.marker'))) return true;
  const root = jobWorktree.WORKTREE_ROOT;
  if (!fs.existsSync(root)) return false;
  for (const h of fs.readdirSync(root)) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, h)); } catch { continue; }
    if (names.some((n) => n.includes(slug))) return true;
  }
  const row = readRow(projectCwd, slug);
  return row.status !== 'pending' || !!row.startedAt;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-preflight-hold-home-'));
  process.env.HOME = tmpHome;
  sched = require('../scheduler.cjs');
  jobWorktree = require('../lib/git/jobWorktree.cjs');
  ({ pickNextBatch } = require('../lib/scheduler/schedulerBatch.cjs'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SM_CLAUDE_BIN;
  jobWorktree._resetActiveWorktreeCountForTests?.(0);
});

test('a red preflight holds the row pending with the first backoff nextAt and launches nothing', async () => {
  const slug = uniq('red');
  const preflight = 'node -e "process.exit(3)"';
  const projectCwd = mkProject([{ slug, preflight }]);
  stubWithMarker();
  const runId = `run-${slug}`;
  const runDir = runDirFor(runId);
  try {
    const t0 = Date.now();
    await sched.spawnJob({ slug, cwd: projectCwd, agentType: 'dev-lead', status: 'pending', preflight }, runId, runDir, projectCwd);
    const row = readRow(projectCwd, slug);
    expect(row.status).toBe('pending');
    expect(row.preflightHold).toBeTruthy();
    expect(row.preflightHold.attempts).toBe(1);
    expect(row.preflightHold.lastExit).toBe(3);
    const nextAt = Date.parse(row.preflightHold.nextAt);
    expect(nextAt).toBeGreaterThanOrEqual(t0 + 10 * MIN);
    expect(nextAt).toBeLessThanOrEqual(Date.now() + 10 * MIN);
    expect(row.heldReason).toBe(`waiting on precondition: ${preflight} exited 3 — re-check at ${row.preflightHold.nextAt}`);
    expect(launched(slug, projectCwd)).toBe(false);
    const ev = auditEvents('preflight_hold').find((e) => JSON.stringify(e).includes(slug));
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).toContain('"exitCode":3');

    // A second failed check climbs the ladder (20 min) and keeps `since`.
    await sched.runPreflightGate({ ...row, preflightHold: { ...row.preflightHold, nextAt: new Date(Date.now() - 1000).toISOString() } }, projectCwd);
    const row2 = readRow(projectCwd, slug);
    expect(row2.preflightHold.attempts).toBe(2);
    expect(row2.preflightHold.since).toBe(row.preflightHold.since);
    expect(Date.parse(row2.preflightHold.nextAt) - Date.now()).toBeGreaterThan(19 * MIN);
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 60_000);

test('a hold that is not yet due is skipped by spawnJob without re-running the preflight', async () => {
  const slug = uniq('notdue');
  const projectCwd = mkProject([{ slug }]);
  const markerCmd = `node -e "require('fs').writeFileSync('preflight-ran.marker','x')"`;
  const hold = { since: new Date().toISOString(), attempts: 1, nextAt: new Date(Date.now() + 5 * MIN).toISOString(), lastExit: 1, lastOutputTail: '', failText: 'x' };
  try {
    const r = await sched.runPreflightGate({ slug, cwd: projectCwd, preflight: markerCmd, preflightHold: hold }, projectCwd);
    expect(r).toBe('held');
    expect(fs.existsSync(path.join(projectCwd, 'preflight-ran.marker'))).toBe(false);
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
}, 30_000);

test('a due re-check that passes clears the hold and dispatches', async () => {
  const slug = uniq('pass');
  const preflight = 'node -e "process.exit(0)"';
  const hold = { since: new Date(Date.now() - 30 * MIN).toISOString(), attempts: 2, nextAt: new Date(Date.now() - 1000).toISOString(), lastExit: 1, lastOutputTail: '', failText: 'x' };
  const heldReason = 'waiting on precondition: x exited 1 — re-check at y';
  const projectCwd = mkProject([{ slug, preflight, preflightHold: hold, heldReason }]);
  stubWithMarker();
  const runId = `run-${slug}`;
  const runDir = runDirFor(runId);
  try {
    await sched.spawnJob({ slug, cwd: projectCwd, agentType: 'dev-lead', status: 'pending', preflight, preflightHold: hold, heldReason }, runId, runDir, projectCwd);
    const row = readRow(projectCwd, slug);
    expect(row.preflightHold).toBeUndefined();
    expect(row.heldReason ?? null).not.toBe(heldReason);
    // Dispatch continued past the gate: the row left 'pending' (ran).
    expect(row.status).not.toBe('pending');
    expect(row.startedAt).toBeTruthy();
    const ev = auditEvents('preflight_pass').find((e) => JSON.stringify(e).includes(slug));
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).toContain('"attempts":2');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 120_000);

test('picker: a not-yet-due held row is skipped without blocking a sibling; its dependent waits until the root completes', () => {
  const cwd = '/tmp/sm-preflight-picker';
  const now = Date.now();
  const hold = { attempts: 1, nextAt: new Date(now + 10 * MIN).toISOString() };
  const jobs = [
    { slug: 'root', status: 'pending', cwd, preflight: 'true', preflightHold: hold, heldReason: 'waiting on precondition: true exited 1 — re-check at z', parallelGroup: 1 },
    { slug: 'dependent', status: 'pending', cwd, dependsOn: ['root'], parallelGroup: 2 },
    { slug: 'sibling', status: 'pending', cwd, parallelGroup: 3 },
  ];
  const held = sched.computePreflightHolds(jobs, now);
  expect([...held.keys()]).toEqual(['root']);
  const r1 = pickNextBatch(jobs, new Set(), 3, { now, heldSlugs: held, machineInUse: 0, leaseHeld: false });
  const picked1 = r1.batch.map((j) => j.slug);
  expect(picked1).toContain('sibling');
  expect(picked1).not.toContain('root');
  expect(picked1).not.toContain('dependent');

  // Hold due → root is pickable again (spawnJob re-checks); dependent still waits.
  const later = now + 11 * MIN;
  const held2 = sched.computePreflightHolds(jobs, later);
  expect(held2.size).toBe(0);
  const r2 = pickNextBatch(jobs, new Set(), 3, { now: later, heldSlugs: held2, machineInUse: 0, leaseHeld: false });
  expect(r2.batch.map((j) => j.slug)).toContain('root');
  expect(r2.batch.map((j) => j.slug)).not.toContain('dependent');

  // Root completes → dependent dispatches with no manual reset.
  const done = jobs.map((j) => (j.slug === 'root' ? { ...j, status: 'completed', preflightHold: undefined } : j));
  const r3 = pickNextBatch(done, new Set(), 3, { now: later, heldSlugs: sched.computePreflightHolds(done, later), machineInUse: 0, leaseHeld: false });
  expect(r3.batch.map((j) => j.slug)).toContain('dependent');
});

test('resetJobFields clears the preflight hold (reset = re-check now)', () => {
  const pendingRow = { slug: 'a', status: 'pending', preflight: 'true', preflightHold: { attempts: 3, nextAt: new Date(Date.now() + MIN).toISOString() }, heldReason: 'waiting on precondition: true exited 1 — re-check at z' };
  sched.resetJobFields(pendingRow, null, { source: 'ipc:schedule:reset-job' });
  expect(pendingRow.preflightHold).toBeUndefined();
  expect(pendingRow.heldReason).toBeUndefined();
  expect(pendingRow.preflight).toBe('true');

  const failedRow = { slug: 'b', status: 'failed', preflight: 'true', preflightHold: { attempts: 1, nextAt: new Date().toISOString() } };
  expect(sched.resetJobFields(failedRow, null, { source: 'ipc:schedule:reset-job' })).toBe(true);
  expect(failedRow.status).toBe('pending');
  expect(failedRow.preflightHold).toBeUndefined();
});

test('a row without preflight is unaffected: no hold, dispatches normally', async () => {
  const slug = uniq('none');
  const projectCwd = mkProject([{ slug }]);
  stubWithMarker();
  const runId = `run-${slug}`;
  const runDir = runDirFor(runId);
  try {
    expect(sched.computePreflightHolds([{ slug, status: 'pending' }]).size).toBe(0);
    await sched.spawnJob({ slug, cwd: projectCwd, agentType: 'dev-lead', status: 'pending' }, runId, runDir, projectCwd);
    const row = readRow(projectCwd, slug);
    expect(row.preflightHold).toBeUndefined();
    expect(row.status).not.toBe('pending');
    expect(auditEvents('preflight_hold').some((e) => JSON.stringify(e).includes(slug))).toBe(false);
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}, 120_000);

test('reconcile copies frontmatter preflight onto the row and a later edit updates it', async () => {
  const prdParser = require('../scheduler/prdParser.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-preflight-parse-'));
  const f = path.join(dir, '1-x.md');
  try {
    fs.writeFileSync(f, '---\ntitle: x\npreflight: "node -e \\"process.exit(1)\\""\n---\nbody\n');
    expect((await prdParser.parsePrdRaw(f)).preflight).toBe('node -e "process.exit(1)"');
    fs.writeFileSync(f, '---\ntitle: x\n---\nbody\n');
    expect((await prdParser.parsePrdRaw(f)).preflight).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Live reconcile pass: the row picks up the frontmatter value, then follows an edit.
  const slug = uniq('reconcile');
  const projectCwd = mkProject([{ slug, preflight: 'node -e "process.exit(1)"' }]);
  try {
    const prdFile = path.join(projectCwd, 'session-manager-operations', 'scheduler', 'epics', 'test-fixture-epic', 'prds', `${slug}.md`);
    // Row starts without the field.
    const q = JSON.parse(fs.readFileSync(queuePath(projectCwd), 'utf8'));
    delete q.jobs[0].preflight;
    fs.writeFileSync(queuePath(projectCwd), JSON.stringify(q));
    await sched._mutateForTests((st) => sched.reconcile(st));
    expect(readRow(projectCwd, slug).preflight).toBe('node -e "process.exit(1)"');
    fs.writeFileSync(prdFile, `---\npreflight: ${JSON.stringify('node -e "process.exit(0)"')}\n---\nPreflight test edited.`, 'utf8');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(prdFile, later, later);
    await sched._mutateForTests((st) => sched.reconcile(st));
    expect(readRow(projectCwd, slug).preflight).toBe('node -e "process.exit(0)"');
  } finally {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  }
}, 60_000);
