/**
 * epicSpawnPlan.test.cjs — PRD 1319: spawn cwd + --resume flag are decided together; a session
 * whose transcript is stranded under a dead worktree encoding is refused BEFORE any CLI spawn
 * with an actionable message, later requests are refused cheaply, closed Epics are refused.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/epicSpawnPlan.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { encodeCwd } = require('../encodeCwd.cjs');
const { planEpicSpawn, __resetForTests } = require('../epicSpawnPlan.cjs');
const { __resetCacheForTests } = require('../epicTranscriptPath.cjs');

const SID = '00ff31cb-56b6-421c-829c-012ef95b15e2';
const PROJECT = '/projects/starry-night-ships';
const DEAD = '/tmp/session-manager-epic-worktrees/abc123/blender-epic-442d711d';

let home;
beforeEach(() => {
  __resetForTests();
  __resetCacheForTests();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-home-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function transcriptUnder(dir) {
  const d = path.join(home, '.claude', 'projects', encodeCwd(dir));
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${SID}.jsonl`);
  fs.writeFileSync(f, '{"type":"user"}\n');
  return f;
}
const epic = (extra = {}) => ({ e1: { id: 'e1', claudeSessionId: SID, status: 'active', worktree: { dir: DEAD, branch: 'sm-epic/e1', baseCwd: PROJECT, status: 'active' }, ...extra } });

test('transcript under a dead worktree encoding + restore failure => refused, names the worktree, no raw CLI text', () => {
  transcriptUnder(DEAD);
  const plan = planEpicSpawn({ cwd: PROJECT, claudeSessionId: SID, deps: { homeDir: home, readActiveIndex: () => ({ sessions: epic() }), restoreWorktree: () => false } });
  expect(plan.ok).toBe(false);
  expect(plan.code).toBe('session_unreachable');
  expect(plan.message).toContain(DEAD);
  expect(plan.message).not.toMatch(/already in use/i);
});

test('circuit breaker: 2nd..Nth request refused without re-running restore', () => {
  transcriptUnder(DEAD);
  let restores = 0;
  const deps = { homeDir: home, readActiveIndex: () => ({ sessions: epic() }), restoreWorktree: () => { restores++; return false; } };
  const first = planEpicSpawn({ cwd: PROJECT, claudeSessionId: SID, deps });
  for (let i = 0; i < 4; i++) expect(planEpicSpawn({ cwd: PROJECT, claudeSessionId: SID, deps })).toEqual(first);
  expect(restores).toBe(1);
});

test('worktree re-attached at the same path => ok, resume, spawn cwd is the worktree', () => {
  transcriptUnder(DEAD);
  const live = new Set();
  const statSync = (p) => (live.has(p) ? { isDirectory: () => true } : fs.statSync(p));
  const plan = planEpicSpawn({
    cwd: PROJECT, claudeSessionId: SID,
    deps: { homeDir: home, readActiveIndex: () => ({ sessions: epic() }), statSync, restoreWorktree: ({ dir }) => { live.add(dir); return true; } },
  });
  expect(plan.ok).toBe(true);
  expect(plan.useResume).toBe(true);
  expect(plan.execCwd).toBe(DEAD);
});

test('transcript under the project encoding, no worktree => ok, resume from project cwd', () => {
  transcriptUnder(PROJECT);
  const plan = planEpicSpawn({ cwd: PROJECT, claudeSessionId: SID, deps: { homeDir: home, readActiveIndex: () => ({ sessions: epic({ worktree: undefined }) }), statSync: (p) => (p === PROJECT ? { isDirectory: () => true } : fs.statSync(p)) } });
  expect(plan).toMatchObject({ ok: true, useResume: true, execCwd: PROJECT });
});

test('merged worktree (dir gone), transcript only under project encoding => ok, resume from project cwd (reported incident)', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-realproj-'));
  try {
    const sid = SID;
    const d = path.join(home, '.claude', 'projects', encodeCwd(proj));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${sid}.jsonl`), '{"type":"user"}\n');
    const merged = epic({ worktree: { dir: DEAD, branch: 'sm-epic/e1', status: 'merged' } });
    const deps = { homeDir: home, readActiveIndex: () => ({ sessions: merged }) };
    const first = planEpicSpawn({ cwd: proj, claudeSessionId: sid, deps });
    expect(first).toMatchObject({ ok: true, execCwd: proj, useResume: true });
    // No circuit-breaker entry from the fallback: a second call is also ok.
    expect(planEpicSpawn({ cwd: proj, claudeSessionId: sid, deps })).toMatchObject({ ok: true, execCwd: proj, useResume: true });
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('merged worktree, no transcript anywhere => ok, real directory, no resume', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-realproj-'));
  try {
    const merged = epic({ worktree: { dir: DEAD, branch: 'sm-epic/e1', status: 'merged' } });
    const plan = planEpicSpawn({ cwd: proj, claudeSessionId: SID, deps: { homeDir: home, readActiveIndex: () => ({ sessions: merged }) } });
    expect(plan.ok).toBe(true);
    expect(plan.useResume).toBe(false);
    expect(fs.statSync(plan.execCwd).isDirectory()).toBe(true);
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('merged worktree, transcript only under dead encoding => refused, no git worktree add command', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-realproj-'));
  try {
    transcriptUnder(DEAD);
    const merged = epic({ worktree: { dir: DEAD, branch: 'sm-epic/e1', status: 'merged' } });
    const plan = planEpicSpawn({ cwd: proj, claudeSessionId: SID, deps: { homeDir: home, readActiveIndex: () => ({ sessions: merged }) } });
    expect(plan).toMatchObject({ ok: false, code: 'session_unreachable' });
    expect(plan.message).toMatch(/merged to main/);
    expect(plan.message).not.toMatch(/git worktree add/);
    expect(plan.message).not.toMatch(/swept from \/tmp/);
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('closed (completed) Epic is refused with its own message', () => {
  const plan = planEpicSpawn({ cwd: PROJECT, claudeSessionId: SID, deps: { homeDir: home, readActiveIndex: () => ({ sessions: epic({ status: 'completed' }) }) } });
  expect(plan).toMatchObject({ ok: false, code: 'epic_closed' });
  expect(plan.message).toMatch(/closed/i);
});

test('chatRunner: dead-encoding transcript => zero CLI spawns, exactly one clear error event', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-proj-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const idxDir = path.join(project, 'session-manager-operations', 'prompt-sessions');
    fs.mkdirSync(idxDir, { recursive: true });
    fs.writeFileSync(path.join(idxDir, 'active-index.json'), JSON.stringify({ sessions: epic() }));
    transcriptUnder(DEAD);
    const cp = require('node:child_process');
    const realSpawn = cp.spawn;
    let spawns = 0;
    cp.spawn = () => { spawns++; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 1; c.kill = () => {}; return c; };
    const chatRunner = require('../../chatRunner.cjs');
    chatRunner.__resetQueueForTests();
    const sent = [];
    chatRunner.attachWindow({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) } });
    try {
      for (let i = 0; i < 3; i++) chatRunner.run({ tabId: `t${i}`, sessionId: SID, prompt: 'hi', cwd: project, resume: true });
      await new Promise((r) => setTimeout(r, 100));
    } finally { cp.spawn = realSpawn; }
    const errs = sent.filter((e) => e.channel === 'chat:run:error');
    expect(spawns).toBe(0);
    expect(errs.length).toBe(3);
    for (const e of errs) expect(e.payload.message).toContain(DEAD);
    // Single-writer law: the rescued session's ops write (error log) lands under the PROJECT root.
    const logsDir = path.join(project, 'session-manager-operations', 'logs');
    expect(fs.existsSync(logsDir)).toBe(true);
    expect(fs.readdirSync(logsDir).some((n) => n.startsWith('errors-'))).toBe(true);
    expect(fs.existsSync(path.join(DEAD, 'session-manager-operations'))).toBe(false);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('chatRunner: silent run refused by planEpicSpawn => onSilentError with the refusal, no broadcasts, no spawn', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-proj-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const idxDir = path.join(project, 'session-manager-operations', 'prompt-sessions');
    fs.mkdirSync(idxDir, { recursive: true });
    fs.writeFileSync(path.join(idxDir, 'active-index.json'), JSON.stringify({ sessions: epic({ status: 'completed' }) }));
    const cp = require('node:child_process');
    const realSpawn = cp.spawn;
    let spawns = 0;
    cp.spawn = () => { spawns++; throw new Error('must not spawn'); };
    const chatRunner = require('../../chatRunner.cjs');
    chatRunner.__resetQueueForTests();
    const sent = [];
    chatRunner.attachWindow({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) } });
    const errors = [];
    const results = [];
    try {
      chatRunner.run({
        tabId: 'silent1', sessionId: SID, prompt: 'hi', cwd: project, resume: true, silent: true,
        onSilentResult: (t) => results.push(t),
        onSilentError: (message, code) => errors.push({ message, code }),
      });
      // no timer: delivery is a few microtasks after run()
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    } finally { cp.spawn = realSpawn; }
    expect(spawns).toBe(0);
    expect(results).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe('epic_closed');
    expect(errors[0].message).toMatch(/closed/i);
    expect(sent.filter((e) => e.channel.startsWith('chat:run:'))).toEqual([]);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(project, { recursive: true, force: true });
  }
});
