/**
 * cancelled-row-dismiss.test.cjs — PRD 3492. A cancelled row (failed +
 * cancelledAt) leaves the queue via queueOps.dismissCancelled, which files its
 * PRD under prds-cancelled/<ts>/ — never read by computeDepHistorySatisfaction.
 * archiveMany refuses cancelled rows with a warning; reconcile auto-dismisses
 * cancelled rows of closed Epics that nothing pending depends on.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs (paths are baked at require).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/cancelled-row-dismiss.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let tmpHome;
let originalHome;
let scheduler;
let queueOps;
let budget;
let prdAdminRoutes;
let config;
let createAdminHttp;
let parsePrdFile;
let auditLogPath;
let activeIndexPath;

const EPIC = 'test-fixture-epic';
const OTHER_EPIC = 'other-fixture-epic';
const CANCELLED_AT = '2026-11-22T10:00:00.000Z';

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cancelled-dismiss-test-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  queueOps = require('../queueOps.cjs');
  budget = require('../scheduler/budget.cjs');
  prdAdminRoutes = require('../lib/prd/prdAdminRoutes.cjs');
  config = require('../config.cjs');
  ({ createAdminHttp } = require('../lib/feedback-remote/localAdminHttp.cjs'));
  ({ parsePrdFile } = require('../lib/prd/prdFrontmatter.cjs'));
  ({ auditLogPath } = require('../lib/scheduler/schedulerPaths.cjs'));
  ({ activeIndexPath } = require('../lib/epic/epicMint.cjs'));
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd: cwdOf() })}\n`);
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(async () => {
  await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  fs.rmSync(path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'epics'), { recursive: true, force: true });
  fs.rmSync(path.join(cwdOf(), 'session-manager-operations', 'prompt-sessions'), { recursive: true, force: true });
});

function cwdOf() {
  return path.join(tmpHome, 'proj');
}

function epicDir(epic = EPIC) {
  return path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'epics', epic);
}

function prdsDir(epic = EPIC) {
  return path.join(epicDir(epic), 'prds');
}

/** rows: [{ slug, dependsOn?, status?, cancelled?, epic? }] → PRD files + queue rows. */
async function seed(rows) {
  const cwd = cwdOf();
  config.addAllowedRoot(cwd);
  for (const r of rows) {
    const dir = prdsDir(r.epic ?? EPIC);
    fs.mkdirSync(dir, { recursive: true });
    const dep = r.dependsOn?.length ? `dependsOn: [${r.dependsOn.join(', ')}]\n` : '';
    fs.writeFileSync(path.join(dir, `${r.slug}.md`), `---\ntitle: ${r.slug}\ncwd: ${cwd}\nestimateMinutes: 10\n${dep}---\n\n# Goal\n\nx\n`);
  }
  await scheduler.writeQueue({
    jobs: rows.map((r) => {
      const row = {
        slug: r.slug, title: r.slug, cwd, epicId: r.epic ?? EPIC,
        status: r.cancelled ? 'failed' : (r.status ?? 'pending'), dependsOn: r.dependsOn ?? [],
      };
      if (r.cancelled) { row.cancelledAt = CANCELLED_AT; row.error = 'cancelled via admin API'; row.finishedAt = CANCELLED_AT; }
      return row;
    }),
    config: {},
    paused: null,
  });
  return cwd;
}

function writeEpicStatuses(map) {
  const file = activeIndexPath(cwdOf());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sessions = {};
  for (const [id, status] of Object.entries(map)) sessions[id] = { id, status };
  fs.writeFileSync(file, JSON.stringify({ sessions, events: {}, tombstones: {} }));
}

async function jobs() {
  const queuePath = path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'state', 'queue.json');
  return JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
}

async function jobOf(slug) {
  return (await jobs()).find((j) => j.slug === slug);
}

function fileDeps(slug) {
  const { frontmatter } = parsePrdFile(fs.readFileSync(path.join(prdsDir(), `${slug}.md`), 'utf8'));
  return frontmatter.dependsOn ?? [];
}

function cancelledFiles(epic = EPIC) {
  const root = path.join(epicDir(epic), 'prds-cancelled');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const ts of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, ts))) out.push(f);
  return out;
}

function auditRows(kind) {
  try {
    return fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
  } catch { return []; }
}

async function satisfied(cwd) {
  const s = await budget.computeDepHistorySatisfaction({ jobs: [{ slug: 'probe', cwd }] });
  return s.get(cwd);
}

test('dismiss removes the cancelled row, moves its PRD to prds-cancelled/<ts>/, writes an audit row', async () => {
  const cwd = await seed([{ slug: '10-dead', cancelled: true }, { slug: '11-other' }]);
  const before = auditRows('job_dismiss_cancelled').length;
  const res = await queueOps.dismissCancelled('10-dead', cwd);
  expect(res.ok).toBe(true);
  expect(res.removed).toBe(true);
  expect(res.movedTo).toMatch(/prds-cancelled[\\/][^\\/]+[\\/]10-dead\.md$/);
  expect(path.dirname(path.dirname(path.dirname(res.movedTo)))).toBe(epicDir());
  expect(fs.existsSync(res.movedTo)).toBe(true);
  expect(fs.existsSync(path.join(prdsDir(), '10-dead.md'))).toBe(false);
  expect(await jobOf('10-dead')).toBeUndefined();
  expect((await jobOf('11-other')).status).toBe('pending');
  const rows = auditRows('job_dismiss_cancelled');
  expect(rows.length).toBe(before + 1);
  expect(rows.at(-1)).toMatchObject({ slug: '10-dead', cwd, source: 'manual', movedTo: res.movedTo });
});

test('dismiss refuses a row without a cancel marker (plain failure, pending, completed)', async () => {
  const cwd = await seed([
    { slug: '10-failed', status: 'failed' },
    { slug: '11-pending' },
    { slug: '12-done', status: 'completed' },
  ]);
  for (const slug of ['10-failed', '11-pending', '12-done']) {
    const res = await queueOps.dismissCancelled(slug, cwd);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a cancelled row/);
    expect(await jobOf(slug)).toBeDefined();
    expect(fs.existsSync(path.join(prdsDir(), `${slug}.md`))).toBe(true);
  }
  expect((await queueOps.dismissCancelled('99-nope', cwd)).error).toMatch(/unknown slug/);
  expect(cancelledFiles()).toEqual([]);
});

const CHAIN = [
  { slug: '10-dead', cancelled: true },
  { slug: '11-a', dependsOn: ['dead'] },
  { slug: '12-b', dependsOn: ['11-a'] },
  { slug: '13-keep' },
];

test('dismiss refuses while pending dependents exist and no choice is passed; nothing changes', async () => {
  const cwd = await seed(CHAIN);
  const res = await queueOps.dismissCancelled('10-dead', cwd);
  expect(res.ok).toBe(false);
  expect(res.dependents).toEqual(['11-a']);
  expect(res.choices).toEqual(['cascade', 'repoint', 'clear']);
  expect(await jobOf('10-dead')).toBeDefined();
  expect(fs.existsSync(path.join(prdsDir(), '10-dead.md'))).toBe(true);
  expect(cancelledFiles()).toEqual([]);
});

test('dismiss with cascade cancels pending dependents transitively, then dismisses the row', async () => {
  const cwd = await seed(CHAIN);
  const res = await queueOps.dismissCancelled('10-dead', cwd, { dependents: { action: 'cascade' } });
  expect(res.ok).toBe(true);
  expect(res.dependents).toMatchObject({ action: 'cascade', slugs: ['11-a', '12-b'] });
  expect(await jobOf('10-dead')).toBeUndefined();
  for (const slug of ['11-a', '12-b']) {
    const j = await jobOf(slug);
    expect(j.status).toBe('failed');
    expect(typeof j.cancelledAt).toBe('string');
    expect(queueOps.isCancelledRow(j)).toBe(true);
  }
  expect((await jobOf('13-keep')).status).toBe('pending');
  expect(auditRows('job_dismiss_cancelled').at(-1)).toMatchObject({ slug: '10-dead', action: 'cascade', dependents: ['11-a', '12-b'] });
});

test('dismiss with repoint rewrites the dependent to the full slug of `to`', async () => {
  const cwd = await seed(CHAIN);
  const res = await queueOps.dismissCancelled('10-dead', cwd, { dependents: { action: 'repoint', to: 'keep' } });
  expect(res.ok).toBe(true);
  expect(fileDeps('11-a')).toEqual(['13-keep']);
  expect((await jobOf('11-a')).dependsOn).toEqual(['13-keep']);
  expect((await jobOf('11-a')).status).toBe('pending');
  expect(await jobOf('10-dead')).toBeUndefined();
  expect(cancelledFiles()).toEqual(['10-dead.md']);
});

test('dismiss with clear drops the dep on the dismissed row', async () => {
  const cwd = await seed([...CHAIN, { slug: '14-two', dependsOn: ['13-keep', '10-dead'] }]);
  const res = await queueOps.dismissCancelled('10-dead', cwd, { dependents: { action: 'clear' } });
  expect(res.ok).toBe(true);
  expect(fileDeps('11-a')).toEqual([]);
  expect(fileDeps('14-two')).toEqual(['13-keep']);
  expect(await jobOf('10-dead')).toBeUndefined();
});

test('a bad dependents choice aborts the dismiss', async () => {
  const cwd = await seed(CHAIN);
  const res = await queueOps.dismissCancelled('10-dead', cwd, { dependents: { action: 'repoint', to: 'missing' } });
  expect(res.ok).toBe(false);
  expect(await jobOf('10-dead')).toBeDefined();
  expect(fileDeps('11-a')).toEqual(['dead']);
});

test('archiveMany on a cancelled row warns to dismiss and does not archive it', async () => {
  const cwd = await seed([{ slug: '10-dead', cancelled: true }, { slug: '11-done', status: 'completed' }]);
  const res = await queueOps.archiveMany(['10-dead', '11-done'], cwd);
  expect(res.warnings).toHaveLength(1);
  expect(res.warnings[0]).toMatch(/10-dead/);
  expect(res.warnings[0]).toMatch(/dismiss/i);
  expect(res.archived).toBe(1);
  const dead = res.results.find((r) => r.slug === '10-dead');
  expect(dead).toMatchObject({ ok: false, cancelled: true });
  expect(fs.existsSync(path.join(prdsDir(), '10-dead.md'))).toBe(true);
  expect(fs.existsSync(path.join(epicDir(), 'prds-archived'))).toBe(true);
  const archived = fs.readdirSync(path.join(epicDir(), 'prds-archived')).flatMap((ts) => fs.readdirSync(path.join(epicDir(), 'prds-archived', ts)));
  expect(archived).toEqual(['11-done.md']);
  expect((await jobOf('10-dead')).status).toBe('failed');
});

test('a dismissed slug never satisfies a dependsOn; an archived one does', async () => {
  const cwd = await seed([{ slug: '10-dead', cancelled: true }, { slug: '11-shipped', status: 'completed' }]);
  expect((await queueOps.dismissCancelled('10-dead', cwd)).ok).toBe(true);
  await queueOps.archiveMany(['11-shipped'], cwd, { retire: false });
  expect(cancelledFiles()).toEqual(['10-dead.md']);
  const set = await satisfied(cwd);
  expect(set instanceof Set).toBe(true);
  expect(set.has('11-shipped')).toBe(true);
  expect(set.has('10-dead')).toBe(false);
});

test('reconcile auto-dismisses cancelled rows of completed/archived Epics, with an audit row', async () => {
  const cwd = await seed([
    { slug: '10-closed', cancelled: true },
    { slug: '20-archived', cancelled: true, epic: OTHER_EPIC },
    { slug: '30-open', cancelled: true, epic: 'open-epic' },
  ]);
  writeEpicStatuses({ [EPIC]: 'completed', [OTHER_EPIC]: 'archived', 'open-epic': 'active' });
  const state = { jobs: await jobs() };
  const res = await queueOps.autoDismissCancelled(state);
  expect(res.dismissed.sort()).toEqual(['10-closed', '20-archived']);
  expect(state.jobs.map((j) => j.slug)).toEqual(['30-open']);
  expect(cancelledFiles()).toEqual(['10-closed.md']);
  expect(cancelledFiles(OTHER_EPIC)).toEqual(['20-archived.md']);
  const rows = auditRows('job_dismiss_cancelled').filter((r) => r.source === 'auto');
  expect(rows.map((r) => r.slug)).toEqual(expect.arrayContaining(['10-closed', '20-archived']));
  expect(rows.find((r) => r.slug === '10-closed')).toMatchObject({ cwd, epicStatus: 'completed' });
});

test('auto-dismiss skips a cancelled row that a pending row in another Epic depends on', async () => {
  await seed([
    { slug: '10-closed', cancelled: true },
    { slug: '20-waiting', dependsOn: ['closed'], epic: OTHER_EPIC },
  ]);
  writeEpicStatuses({ [EPIC]: 'completed', [OTHER_EPIC]: 'active' });
  const state = { jobs: await jobs() };
  const res = await queueOps.autoDismissCancelled(state);
  expect(res.dismissed).toEqual([]);
  expect(state.jobs.map((j) => j.slug).sort()).toEqual(['10-closed', '20-waiting']);
  expect(fs.existsSync(path.join(prdsDir(), '10-closed.md'))).toBe(true);
});

test('reconcile() runs auto-dismiss inside its mutate pass', async () => {
  await seed([{ slug: '10-closed', cancelled: true }, { slug: '11-live' }]);
  writeEpicStatuses({ [EPIC]: 'completed' });
  await scheduler._mutateForTests((s) => scheduler.reconcile(s));
  expect(await jobOf('10-closed')).toBeUndefined();
  expect(cancelledFiles()).toEqual(['10-closed.md']);
});

function request(port, { path: reqPath, token, body }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: reqPath,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

test('admin route POST /admin/scheduler/dismiss-cancelled: 409 refusals, 200 with a choice', async () => {
  const cwd = await seed([...CHAIN, { slug: '15-plain', status: 'failed' }]);
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  prdAdminRoutes.registerAdminRoute(admin, scheduler.remote);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  try {
    const p = '/admin/scheduler/dismiss-cancelled';
    const plain = await request(port, { path: p, token, body: { slug: '15-plain', cwd } });
    expect(plain.status).toBe(409);
    const refused = await request(port, { path: p, token, body: { slug: '10-dead', cwd } });
    expect(refused.status).toBe(409);
    expect(refused.json.dependents).toEqual(['11-a']);
    const ok = await request(port, { path: p, token, body: { slug: '10-dead', cwd, dependents: { action: 'clear' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.removed).toBe(true);
    expect(await jobOf('10-dead')).toBeUndefined();
  } finally {
    await admin.stop();
  }
});
