/**
 * eventsAdminRoutes-epic.test.cjs — GET /admin/events?epicId=… replays one
 * Epic's per-Epic event log (epicEventLog.cjs readEpicEvents) over a real
 * admin HTTP instance; calls without epicId keep the audit-log contract.
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/eventsAdminRoutes-epic.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const EPIC = 'epic-replay-1';
let tmpHome;
let cwd;
let prevSchedulerHome;
let eventsAdminRoutes;
let createAdminHttp;

const AUDIT_ROWS = [
  { at: '2026-11-01T00:00:00.000Z', kind: 'epic_state_changed', epicId: 'e1', caller: 'x' },
  { at: '2026-11-01T00:00:01.000Z', kind: 'job_transition', slug: 's1' },
];

beforeAll(async () => {
  prevSchedulerHome = process.env.SM_SCHEDULER_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-admin-epic-events-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-admin-epic-events-cwd-'));
  process.env.SM_SCHEDULER_HOME = tmpHome;
  eventsAdminRoutes = require('../eventsAdminRoutes.cjs');
  ({ createAdminHttp } = require('../../feedback-remote/localAdminHttp.cjs'));
  const { auditLogPath } = require('../../scheduler/schedulerPaths.cjs');
  if (!auditLogPath().startsWith(tmpHome)) throw new Error(`refusing to run: audit log ${auditLogPath()} not under ${tmpHome}`);
  fs.writeFileSync(auditLogPath(), AUDIT_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const log = require('../../epic/epicEventLog.cjs');
  log._resetForTests();
  await log.appendEpicEvent(cwd, EPIC, { kind: 'epic.minted', summary: 'born' });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'job.queued', prdId: 1 });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'human.message', summary: 'hi' });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'job.queued', prdId: 2 });
  await log.appendEpicEvent(cwd, EPIC, { kind: 'validator.verdict', verdict: 'VERIFIED' });
});

afterAll(() => {
  if (prevSchedulerHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedulerHome;
  for (const d of [tmpHome, cwd]) fs.rmSync(d, { recursive: true, force: true });
});

function get(port, token, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withAdmin(fn, deps) {
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  eventsAdminRoutes.registerAdminRoute(admin, deps);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  try {
    return await fn((p) => get(port, token, p));
  } finally {
    await admin.stop();
  }
}

const q = (params) => `/admin/events?${new URLSearchParams({ epicId: EPIC, cwd, ...params }).toString()}`;

test('replays every event kind of the Epic in seq order', async () => {
  await withAdmin(async (call) => {
    const r = await call(q({}));
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['cursor', 'events', 'hasMore', 'ok']);
    expect(r.json.events.map((e) => e.kind)).toEqual(['epic.minted', 'job.queued', 'human.message', 'job.queued', 'validator.verdict']);
    expect(r.json.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.json.cursor).toBe(5);
    expect(r.json.hasMore).toBe(false);
    const s = await call(q({ after: 'start' }));
    expect(s.json.events).toHaveLength(5);
  });
});

test('cursor paging resumes after the returned cursor', async () => {
  await withAdmin(async (call) => {
    const a = await call(q({ limit: '2' }));
    expect(a.json.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(a.json).toMatchObject({ cursor: 2, hasMore: true });
    const b = await call(q({ limit: '2', after: String(a.json.cursor) }));
    expect(b.json.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(b.json.hasMore).toBe(true);
    const c = await call(q({ limit: '2', after: String(b.json.cursor) }));
    expect(c.json.events.map((e) => e.seq)).toEqual([5]);
    expect(c.json).toMatchObject({ cursor: 5, hasMore: false });
    const d = await call(q({ after: '5' }));
    expect(d.json).toMatchObject({ events: [], cursor: 5, hasMore: false });
  });
});

test('limit above 500 is capped, not rejected', async () => {
  await withAdmin(async (call) => {
    const r = await call(q({ limit: '100000' }));
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(5);
  });
});

test('kinds filter keeps only the named kinds; an unknown kind is 400', async () => {
  await withAdmin(async (call) => {
    const r = await call(q({ kinds: 'job.queued,validator.verdict' }));
    expect(r.status).toBe(200);
    expect(r.json.events.map((e) => e.seq)).toEqual([2, 4, 5]);
    const bad = await call(q({ kinds: 'nope.nope' }));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, error: 'invalid query' });
  });
});

test('a malformed cursor is 400', async () => {
  await withAdmin(async (call) => {
    for (const after of ['abc', '-1', '1.5', '2026-11-01T00:00:00.000Z~1', '']) {
      const r = await call(q({ after }));
      expect(r.status, `after=${after}`).toBe(400);
      expect(r.json).toMatchObject({ ok: false, error: 'invalid query' });
    }
    const badId = await call(`/admin/events?${new URLSearchParams({ epicId: 'a/b', cwd })}`);
    expect(badId.status).toBe(400);
  });
});

test('an unknown epicId returns an empty page (with and without cwd)', async () => {
  await withAdmin(async (call) => {
    const withCwd = await call(`/admin/events?${new URLSearchParams({ epicId: 'epic-nobody', cwd })}`);
    expect(withCwd.status).toBe(200);
    expect(withCwd.json).toEqual({ ok: true, events: [], cursor: 0, hasMore: false });
    const noCwd = await call('/admin/events?epicId=epic-nobody&after=3');
    expect(noCwd.status).toBe(200);
    expect(noCwd.json).toEqual({ ok: true, events: [], cursor: 3, hasMore: false });
  }, { projectRoots: () => [] });
});

test('no epicId → today\'s audit-log response shape, unchanged', async () => {
  await withAdmin(async (call) => {
    const r = await call('/admin/events?after=start&kinds=epic_state_changed,job_transition');
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['events', 'gap', 'more', 'next', 'ok']);
    expect(r.json.events.map((e) => e.kind)).toEqual(['epic_state_changed', 'job_transition']);
    expect(r.json.events[0].caller).toBeUndefined();
    expect(r.json.more).toBe(false);
    const bad = await call('/admin/events?after=garbage');
    expect(bad.status).toBe(400);
    const badKind = await call('/admin/events?after=start&kinds=epic.minted');
    expect(badKind.status).toBe(400);
  });
});
