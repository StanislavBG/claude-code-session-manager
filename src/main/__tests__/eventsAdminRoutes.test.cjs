/**
 * eventsAdminRoutes.test.cjs — GET /admin/events over a real admin HTTP
 * instance, reading a temp audit log under a temp SM_SCHEDULER_HOME.
 * Pattern: prdAdminRoutes.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/eventsAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let tmpHome;
let prevSchedulerHome;
let eventsAdminRoutes;
let createAdminHttp;
let auditLogPath;

const ROWS = [
  { at: '2026-11-01T00:00:00.000Z', kind: 'epic_state_changed', epicId: 'e1', caller: 'x' },
  { at: '2026-11-01T00:00:01.000Z', kind: 'job_transition', slug: 's1' },
  { at: '2026-11-01T00:00:02.000Z', kind: 'prd_created', slug: 's2' },
  { at: '2026-11-01T00:00:03.000Z', kind: 'epic_state_changed', epicId: 'e2' },
  { at: '2026-11-01T00:00:04.000Z', kind: 'epic_cross_project_reply', epicId: 'e1', mode: 'event', outcome: 'done', message: 'Fixed.', caller: 'y' },
  { at: '2026-11-01T00:00:05.000Z', kind: 'needs_you_answered', app: 'portfolio', id: 'q-1', answer: 'yes', externalRef: 'portfolio:action-1', caller: 'z' },
];

beforeAll(() => {
  prevSchedulerHome = process.env.SM_SCHEDULER_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-admin-events-'));
  process.env.SM_SCHEDULER_HOME = tmpHome;
  eventsAdminRoutes = require('../lib/telemetry/eventsAdminRoutes.cjs');
  ({ createAdminHttp } = require('../lib/feedback-remote/localAdminHttp.cjs'));
  ({ auditLogPath } = require('../lib/scheduler/schedulerPaths.cjs'));
  if (!auditLogPath().startsWith(tmpHome)) throw new Error(`refusing to run: audit log ${auditLogPath()} not under ${tmpHome}`);
  fs.writeFileSync(auditLogPath(), ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
});

afterAll(() => {
  if (prevSchedulerHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedulerHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function request(port, { path: reqPath, token }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withAdmin(fn) {
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  eventsAdminRoutes.registerAdminRoute(admin);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  try {
    return await fn(port, token);
  } finally {
    await admin.stop();
  }
}

test('GET /admin/events without token returns 401', async () => {
  await withAdmin(async (port) => {
    const res = await request(port, { path: '/admin/events' });
    expect(res.status).toBe(401);
  });
});

test('GET /admin/events with no cursor returns no events and the newest cursor', async () => {
  await withAdmin(async (port, token) => {
    const res = await request(port, { path: '/admin/events', token });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, events: [], next: '2026-11-01T00:00:05.000Z~1', more: false, gap: false });
  });
});

test('GET /admin/events?after=start returns default-kind events with caller stripped', async () => {
  await withAdmin(async (port, token) => {
    const res = await request(port, { path: '/admin/events?after=start', token });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.events).toEqual([
      { at: '2026-11-01T00:00:00.000Z', kind: 'epic_state_changed', epicId: 'e1' },
      { at: '2026-11-01T00:00:03.000Z', kind: 'epic_state_changed', epicId: 'e2' },
    ]);
    expect(res.json.next).toBe('2026-11-01T00:00:05.000Z~1');
    expect(res.json.more).toBe(false);
    expect(res.json.gap).toBe(false);
  });
});

test('GET /admin/events?kinds=epic_cross_project_reply returns reply rows with caller stripped', async () => {
  await withAdmin(async (port, token) => {
    const res = await request(port, { path: '/admin/events?after=start&kinds=epic_cross_project_reply', token });
    expect(res.status).toBe(200);
    expect(res.json.events).toEqual([
      { at: '2026-11-01T00:00:04.000Z', kind: 'epic_cross_project_reply', epicId: 'e1', mode: 'event', outcome: 'done', message: 'Fixed.' },
    ]);
    expect(res.json.next).toBe('2026-11-01T00:00:05.000Z~1');
    expect(res.json.more).toBe(false);
  });
});

test('GET /admin/events?kinds=needs_you_answered returns answered rows with caller stripped', async () => {
  await withAdmin(async (port, token) => {
    const res = await request(port, { path: '/admin/events?after=start&kinds=needs_you_answered', token });
    expect(res.status).toBe(200);
    expect(res.json.events).toEqual([
      { at: '2026-11-01T00:00:05.000Z', kind: 'needs_you_answered', app: 'portfolio', id: 'q-1', answer: 'yes', externalRef: 'portfolio:action-1' },
    ]);
    expect(res.json.next).toBe('2026-11-01T00:00:05.000Z~1');
    expect(res.json.more).toBe(false);
  });
});

test('GET /admin/events kinds filter and limit page through with more/next', async () => {
  await withAdmin(async (port, token) => {
    const only = await request(port, { path: '/admin/events?after=start&kinds=job_transition', token });
    expect(only.status).toBe(200);
    expect(only.json.events.map((e) => e.slug)).toEqual(['s1']);

    const first = await request(port, { path: '/admin/events?after=start&kinds=epic_state_changed,job_transition&limit=1', token });
    expect(first.status).toBe(200);
    expect(first.json.events.map((e) => e.kind)).toEqual(['epic_state_changed']);
    expect(first.json.more).toBe(true);

    const second = await request(port, { path: `/admin/events?after=${encodeURIComponent(first.json.next)}&kinds=epic_state_changed,job_transition&limit=500`, token });
    expect(second.status).toBe(200);
    expect(second.json.events.map((e) => e.kind)).toEqual(['job_transition', 'epic_state_changed']);
    expect(second.json.more).toBe(false);
  });
});

test.each([
  ['unknown kind', '/admin/events?after=start&kinds=epic_state_changed,prd_created'],
  ['empty kinds', '/admin/events?after=start&kinds='],
  ['limit 0', '/admin/events?after=start&limit=0'],
  ['limit 501', '/admin/events?after=start&limit=501'],
  ['non-numeric limit', '/admin/events?after=start&limit=abc'],
  ['malformed cursor', '/admin/events?after=yesterday'],
])('GET /admin/events rejects %s with 400 invalid query', async (_label, reqPath) => {
  await withAdmin(async (port, token) => {
    const res = await request(port, { path: reqPath, token });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toBe('invalid query');
    expect(res.json.details).toBeTruthy();
  });
});

test('GET /admin/events answers a malformed cursor with 400 carrying the reader\'s message', async () => {
  await withAdmin(async (port, token) => {
    const res = await request(port, { path: '/admin/events?after=yesterday', token });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, error: 'invalid query', details: expect.stringMatching(/^invalid audit cursor "yesterday": expected/) });
  });
});

test('GET /admin/events writes no file and no audit row', async () => {
  const before = fs.readFileSync(auditLogPath(), 'utf8');
  const filesBefore = fs.readdirSync(tmpHome).sort();
  await withAdmin(async (port, token) => {
    await request(port, { path: '/admin/events?after=start', token });
    await request(port, { path: '/admin/events?after=bad', token });
  });
  expect(fs.readFileSync(auditLogPath(), 'utf8')).toBe(before);
  expect(fs.readdirSync(tmpHome).sort()).toEqual(filesBefore);
});
