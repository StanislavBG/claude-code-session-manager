/**
 * epicStateFromLog.test.cjs — GET /admin/events kind epic_state_changed is
 * served from the per-Epic event log's epic.state_changed events (written by
 * lib/epic/epicStateEmitter.cjs), in the outside shape of contract v1:
 * { at, kind, cwd, epicId, from, to, blockedKind?, externalRef? } — only keys
 * from CONTRACT.epicStateChangedFields. epic.status_changed (lifecycle-only)
 * yields no row.
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/epicStateFromLog.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let tmpHome;
let cwd;
let other;
let prevSchedulerHome;
let auditEvents;
let log;
let auditLogPath;
const roots = () => [cwd, other];
const read = () => auditEvents.readEventsAfter({ after: 'start', kinds: ['epic_state_changed'], projectRoots: roots });
const noAt = (events) => events.map(({ at: _at, ...r }) => r);

function writeIndex(dir, sessions) {
  const ps = path.join(dir, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(ps, { recursive: true });
  fs.writeFileSync(path.join(ps, 'active-index.json'), JSON.stringify({ sessions, events: {} }));
}

beforeAll(() => {
  prevSchedulerHome = process.env.SM_SCHEDULER_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-state-log-'));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-state-log-cwd-')));
  other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-epic-state-log-other-')));
  process.env.SM_SCHEDULER_HOME = tmpHome;
  auditEvents = require('../auditEvents.cjs');
  log = require('../../epic/epicEventLog.cjs');
  ({ auditLogPath } = require('../../scheduler/schedulerPaths.cjs'));
  if (!auditLogPath().startsWith(tmpHome)) throw new Error(`refusing to run: audit log ${auditLogPath()} not under ${tmpHome}`);
});

afterAll(() => {
  if (prevSchedulerHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedulerHome;
  for (const d of [tmpHome, cwd, other]) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  for (const d of [cwd, other]) fs.rmSync(path.join(d, 'session-manager-operations'), { recursive: true, force: true });
  try { fs.rmSync(auditLogPath(), { force: true }); } catch { /* none */ }
  log._resetForTests();
  auditEvents._resetEpicStateCacheForTests();
});

test('epic.state_changed events become epic_state_changed rows with the outside shape', async () => {
  const { CONTRACT } = require('../../externalContract.cjs');
  writeIndex(cwd, { 'e-1': { id: 'e-1', status: 'active', source: { externalRef: 'ref-1' } } });
  await log.appendEpicEvent(cwd, 'e-1', { kind: 'epic.state_changed', from: 'open', to: 'working' });
  await log.appendEpicEvent(cwd, 'e-1', { kind: 'epic.state_changed', from: 'working', to: 'blocked', blockedKind: 'needs_input' });
  await log.appendEpicEvent(cwd, 'e-1', { kind: 'epic.state_changed', from: 'blocked', to: 'verified' });
  await log.appendEpicEvent(other, 'e-2', { kind: 'epic.state_changed', to: 'working', externalRef: 'ref-own' });

  const { events } = read();
  expect(events).toHaveLength(4);
  const allowed = new Set(CONTRACT.epicStateChangedFields);
  for (const ev of events) {
    for (const k of Object.keys(ev)) expect(allowed.has(k), `unlisted key ${k}`).toBe(true);
    for (const k of ['at', 'kind', 'cwd', 'epicId', 'from', 'to']) expect(ev, `required key ${k}`).toHaveProperty(k);
    expect(ev.kind).toBe('epic_state_changed');
    expect(typeof ev.at).toBe('string');
  }
  expect(noAt(events)).toEqual(expect.arrayContaining([
    { kind: 'epic_state_changed', cwd, epicId: 'e-1', from: 'open', to: 'working', externalRef: 'ref-1' },
    { kind: 'epic_state_changed', cwd, epicId: 'e-1', from: 'working', to: 'blocked', blockedKind: 'needs_input', externalRef: 'ref-1' },
    { kind: 'epic_state_changed', cwd, epicId: 'e-1', from: 'blocked', to: 'verified', externalRef: 'ref-1' },
    { kind: 'epic_state_changed', cwd: other, epicId: 'e-2', from: null, to: 'working', externalRef: 'ref-own' },
  ]));
  // Oldest first.
  expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
});

test('blockedKind is carried only on a blocked row', async () => {
  await log.appendEpicEvent(cwd, 'e-k', { kind: 'epic.state_changed', from: 'blocked', to: 'working', blockedKind: 'stale' });
  await log.appendEpicEvent(cwd, 'e-k', { kind: 'epic.state_changed', from: 'working', to: 'blocked', blockedKind: '' });
  expect(noAt(read().events)).toEqual([
    { kind: 'epic_state_changed', cwd, epicId: 'e-k', from: 'blocked', to: 'working' },
    { kind: 'epic_state_changed', cwd, epicId: 'e-k', from: 'working', to: 'blocked' },
  ]);
});

test('an epic.status_changed event yields no row', async () => {
  await log.appendEpicEvent(cwd, 'e-s', { kind: 'epic.status_changed', from: 'proposed', to: 'active' });
  expect(read().events).toEqual([]);
  expect(auditEvents.epicStateRowOf(cwd, { kind: 'epic.status_changed', time: '2026-11-01T00:00:00.000Z', epicId: 'e-s', from: 'proposed', to: 'active' })).toBeNull();
  expect(auditEvents).not.toHaveProperty('STATUS_TO_OUTSIDE');
});

test('the incremental cache picks up appended lines', async () => {
  await log.appendEpicEvent(cwd, 'e-i', { kind: 'epic.state_changed', from: 'open', to: 'working' });
  expect(read().events).toHaveLength(1);
  await log.appendEpicEvent(cwd, 'e-i', { kind: 'job.queued', prdId: 1 });
  await log.appendEpicEvent(cwd, 'e-i', { kind: 'epic.state_changed', from: 'working', to: 'verified' });
  expect(noAt(read().events)).toEqual([
    { kind: 'epic_state_changed', cwd, epicId: 'e-i', from: 'open', to: 'working' },
    { kind: 'epic_state_changed', cwd, epicId: 'e-i', from: 'working', to: 'verified' },
  ]);
});

test('rows are merged with audit rows by at and one cursor pages through both', async () => {
  await log.appendEpicEvent(cwd, 'e-a', { kind: 'epic.state_changed', from: 'open', to: 'working' });
  await log.appendEpicEvent(cwd, 'e-a', { kind: 'job.queued', prdId: 1 }); // not a state change
  const [first] = (await log.readEpicEvents(cwd, 'e-a')).events;
  const before = new Date(Date.parse(first.time) - 1000).toISOString();
  const after = new Date(Date.parse(first.time) + 1000).toISOString();
  fs.writeFileSync(auditLogPath(), [
    { at: before, kind: 'job_transition', slug: 's0' },
    { at: after, kind: 'job_transition', slug: 's1' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const kinds = ['epic_state_changed', 'job_transition'];
  const all = auditEvents.readEventsAfter({ after: 'start', kinds, projectRoots: roots });
  expect(all.events.map((e) => e.kind)).toEqual(['job_transition', 'epic_state_changed', 'job_transition']);

  const p1 = auditEvents.readEventsAfter({ after: 'start', kinds, limit: 2, projectRoots: roots });
  expect(p1.more).toBe(true);
  const p2 = auditEvents.readEventsAfter({ after: p1.next, kinds, limit: 2, projectRoots: roots });
  expect([...p1.events, ...p2.events]).toEqual(all.events);

  // "from now" cursor covers the newest row; a later state change shows up after it.
  const now = auditEvents.readEventsAfter({ kinds, projectRoots: roots });
  expect(now.events).toEqual([]);
  await new Promise((r) => setTimeout(r, 1100)); // be newer than the audit row at `after`
  await log.appendEpicEvent(cwd, 'e-a', { kind: 'epic.state_changed', from: 'working', to: 'verified' });
  const fresh = auditEvents.readEventsAfter({ after: now.next, kinds, projectRoots: roots });
  expect(noAt(fresh.events)).toEqual([
    { kind: 'epic_state_changed', cwd, epicId: 'e-a', from: 'working', to: 'verified' },
  ]);
});

test('legacy epic_state_changed audit rows are returned unchanged', async () => {
  const legacy = { at: '2026-11-01T00:00:00.000Z', kind: 'epic_state_changed', cwd, epicId: 'legacy', from: 'open', to: 'working' };
  fs.writeFileSync(auditLogPath(), `${JSON.stringify(legacy)}\n`);
  await log.appendEpicEvent(cwd, 'e-l', { kind: 'epic.state_changed', from: 'open', to: 'working' });
  const { events } = read();
  expect(events[0]).toEqual(legacy);
  expect(events.map((e) => e.epicId)).toEqual(['legacy', 'e-l']);
});

test('an explicit target with no projectRoots reads the audit log only', async () => {
  await log.appendEpicEvent(cwd, 'e-b', { kind: 'epic.state_changed', from: 'open', to: 'working' });
  const target = path.join(tmpHome, 'only.jsonl');
  fs.writeFileSync(target, `${JSON.stringify({ at: '2026-11-01T00:00:00.000Z', kind: 'epic_state_changed', epicId: 'legacy' })}\n`);
  const { events } = auditEvents.readEventsAfter({ after: 'start', target });
  expect(events.map((e) => e.epicId)).toEqual(['legacy']);
});

test('GET /admin/events serves epic_state_changed from the event log', async () => {
  const eventsAdminRoutes = require('../eventsAdminRoutes.cjs');
  const { createAdminHttp } = require('../../feedback-remote/localAdminHttp.cjs');
  await log.appendEpicEvent(cwd, 'e-c', { kind: 'epic.state_changed', from: 'working', to: 'blocked', blockedKind: 'needs_input' });
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  eventsAdminRoutes.registerAdminRoute(admin, { projectRoots: roots });
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: '/admin/events?after=start', headers: { Authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(200);
    expect(noAt(r.json.events)).toEqual([
      { kind: 'epic_state_changed', cwd, epicId: 'e-c', from: 'working', to: 'blocked', blockedKind: 'needs_input' },
    ]);
  } finally {
    await admin.stop();
  }
});
