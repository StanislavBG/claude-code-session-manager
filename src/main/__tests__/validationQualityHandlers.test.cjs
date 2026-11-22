/**
 * validationQualityHandlers.test.cjs — the gather (active index + archived
 * Epics + queue + history shard) on temp fixtures, the history:validation-quality
 * IPC shape (no machine-wide project scan), and GET /admin/validation-quality
 * 200/400/404. Temp SM_SCHEDULER_HOME and temp project roots only.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/validationQualityHandlers.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const activeSessions = require('../lib/activeSessions.cjs');
const { projectHistoryPath } = require('../lib/scheduler/queueStore.cjs');
const {
  gatherValidationQuality,
  registerValidationQualityHandlers,
  registerAdminRoute,
} = require('../validationQualityHandlers.cjs');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const tmpDirs = [];
let prevHome;

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return fs.realpathSync(d);
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-vq-home-');
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

const verdict = (prdSlug, validation, atMs, extra = {}) => ({
  kind: 'response', prdSlug, validation, at: iso(atMs), ...extra,
});

/**
 * Project fixture:
 *  - open Epic e-open (active index): 10-a VERIFIED by 12-validate-x, 11-b REFUTED
 *  - archived Epic e-done: 11-b VERIFIED later, 20-c VERIFIED by 22-validate-y
 *  - history shard: 20-c, 22-validate-y, and fix row 30-fix-c (fixes 20-c, created after 20-c's VERIFIED)
 *  - queue: 10-a, 11-b, 12-validate-x
 */
async function makeProject(name) {
  const base = await mkTmp(`sm-vq-${name}-`);
  const cwd = path.join(base, name);
  const ps = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(ps, { recursive: true });
  const t = NOW - 2 * DAY;
  fs.writeFileSync(path.join(ps, 'active-index.json'), JSON.stringify({
    sessions: { 'e-open': { id: 'e-open', cwd, status: 'active' } },
    events: {
      'e-open': [
        { kind: 'prd_created', prdSlug: '10-a', at: iso(t - 1000) },
        verdict('10-a', 'verified', t, { validator: '12-validate-x' }),
        verdict('11-b', 'refuted', t, { validator: '12-validate-x', missKinds: ['gate-red'], reason: 'gate red' }),
      ],
    },
  }));
  fs.writeFileSync(path.join(ps, 'e-done.json'), JSON.stringify({
    archivedAt: iso(t),
    session: { id: 'e-done', cwd, status: 'completed' },
    events: [
      verdict('11-b', 'verified', t + 1000, { validator: '12-validate-x' }),
      verdict('20-c', 'verified', t, { validator: '22-validate-y' }),
    ],
  }));
  const histFile = projectHistoryPath(cwd);
  fs.mkdirSync(path.dirname(histFile), { recursive: true });
  const hist = [
    { slug: '20-c', cwd, status: 'completed', agentType: 'dev-lead', dependsOn: [], createdAt: iso(t - DAY) },
    { slug: '22-validate-y', cwd, status: 'completed', agentType: 'validator', dependsOn: ['20-c'], createdAt: iso(t - DAY) },
    { slug: '30-fix-c', cwd, status: 'completed', agentType: 'dev-lead', dependsOn: [], createdAt: iso(t + 3600e3), fixes: ['20-c'], missKind: 'behavior-wrong', reason: 'c is wrong' },
    { kind: 'needs_review_entry', slug: '30-fix-c', cwd },
  ];
  fs.writeFileSync(histFile, hist.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const queue = [
    { slug: '10-a', cwd, status: 'completed', agentType: 'dev-lead', dependsOn: [], createdAt: iso(t - DAY) },
    { slug: '11-b', cwd, status: 'completed', agentType: 'dev-lead', dependsOn: [], createdAt: iso(t - DAY) },
    { slug: '12-validate-x', cwd, status: 'completed', agentType: 'validator', dependsOn: ['10-a', '11-b'], createdAt: iso(t - DAY) },
  ];
  return { cwd, queue };
}

test('gather reads the active index, archived Epics, queue and history shard of one project', async () => {
  const { cwd, queue } = await makeProject('alpha');
  const out = await gatherValidationQuality({
    cwd, nowMs: NOW, projectRoots: () => [cwd], loadQueueJobs: async () => queue,
  });
  expect(out.ok).toBe(true);
  expect(out.projects).toHaveLength(1);
  const p = out.projects[0];
  expect(p.cwd).toBe(cwd);
  expect(p.project).toBe('alpha');
  // a, c first-pass VERIFIED; b refuted then verified (active index + archive merged).
  expect(p.firstPass.prds).toEqual(['a', 'c']);
  expect(p.refuted.prds).toEqual(['b']);
  // The fix row from the history shard is an escape of c (verified by 22-validate-y).
  expect(p.escapes).toHaveLength(1);
  expect(p.escapes[0]).toMatchObject({ fixPrd: 'fix-c', escapedPrd: 'c', verifiedBy: '22-validate-y', missKind: 'behavior-wrong' });
  expect(p.week.missKinds['gate-red']).toBe(1);
  expect(p.week.missKinds['behavior-wrong']).toBe(1);
});

test('gather never throws: a failing loader resolves { ok: false, error }', async () => {
  const out = await gatherValidationQuality({ loadQueueJobs: async () => { throw new Error('boom'); } });
  expect(out).toEqual({ ok: false, error: 'boom' });
  expect(await gatherValidationQuality({ cwd: 'relative/path' })).toMatchObject({ ok: false });
});

test('IPC history:validation-quality returns { ok: true, projects } for every project with rows, without a project scan', async () => {
  const a = await makeProject('alpha');
  const b = await makeProject('beta');
  const scanAll = vi.spyOn(activeSessions, 'allProjectCwds');
  const scanActive = vi.spyOn(activeSessions, 'activeProjectCwds');
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  registerValidationQualityHandlers({
    ipcMain,
    gather: (opts) => gatherValidationQuality({
      ...opts,
      nowMs: NOW,
      loadQueueJobs: async () => a.queue,
      // beta has no live queue rows — only history — and still shows up.
      loadRecentHistory: async () => [{ slug: '20-c', cwd: b.cwd, status: 'completed' }],
    }),
  });
  const handler = handlers.get('history:validation-quality');
  expect(typeof handler).toBe('function');
  const out = await handler({});
  expect(out.ok).toBe(true);
  expect(out.projects.map((p) => p.cwd).sort()).toEqual([a.cwd, b.cwd].sort());
  const beta = out.projects.find((p) => p.cwd === b.cwd);
  // beta's archive was readable with the rows' cwds as the registered roots.
  expect(beta.firstPass.prds).toEqual(['a', 'c']);
  expect(beta.escapes.map((e) => e.escapedPrd)).toEqual(['c']);
  expect(scanAll).not.toHaveBeenCalled();
  expect(scanActive).not.toHaveBeenCalled();
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(chunk) { if (chunk) this.body += String(chunk); },
    get json() { return JSON.parse(this.body); },
  };
}

async function callRoute(deps, query) {
  const routes = new Map();
  registerAdminRoute({ registerRoute: (m, p, fn) => routes.set(`${m} ${p}`, fn) }, deps);
  const fn = routes.get('GET /admin/validation-quality');
  expect(typeof fn).toBe('function');
  const res = fakeRes();
  await fn({}, res, new URLSearchParams(query));
  return res;
}

test('GET /admin/validation-quality: 200 for a registered project, 400 missing/relative cwd, 404 unregistered', async () => {
  const { cwd, queue } = await makeProject('alpha');
  const deps = { projectRoots: () => [cwd], nowMs: () => NOW, loadQueueJobs: async () => queue };

  const ok = await callRoute(deps, { cwd });
  expect(ok.statusCode).toBe(200);
  expect(ok.json.ok).toBe(true);
  expect(ok.json.project).toMatchObject({ cwd, project: 'alpha', firstPass: { prds: ['a', 'c'] } });

  expect((await callRoute(deps, {})).statusCode).toBe(400);
  expect((await callRoute(deps, { cwd: 'relative/dir' })).statusCode).toBe(400);

  const other = await makeProject('gamma');
  const nf = await callRoute(deps, { cwd: other.cwd });
  expect(nf.statusCode).toBe(404);
  expect(nf.json.ok).toBe(false);
});
