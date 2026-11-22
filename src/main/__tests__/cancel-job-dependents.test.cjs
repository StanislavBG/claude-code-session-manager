/**
 * cancel-job-dependents.test.cjs — remote.cancelJob refuses while pending PRDs
 * depend on the target unless a dependents choice is passed, then applies it
 * (cascade / repoint / clear) before the target cancel, with one
 * job_cancel_dependents audit row (PRD 3499). Also the admin route's 409.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs (paths are baked at require).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/cancel-job-dependents.test.cjs
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
let prdAdminRoutes;
let config;
let createAdminHttp;
let parsePrdFile;
let auditLogPath;

const EPIC = 'test-fixture-epic';

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-dependents-test-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  prdAdminRoutes = require('../lib/prd/prdAdminRoutes.cjs');
  config = require('../config.cjs');
  ({ createAdminHttp } = require('../lib/feedback-remote/localAdminHttp.cjs'));
  ({ parsePrdFile } = require('../lib/prd/prdFrontmatter.cjs'));
  ({ auditLogPath } = require('../lib/scheduler/schedulerPaths.cjs'));
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
});

function cwdOf() {
  return path.join(tmpHome, 'proj');
}

function prdsDir() {
  return path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'epics', EPIC, 'prds');
}

/** rows: [{ slug, dependsOn?, status? }] → PRD files + queue rows. */
async function seed(rows) {
  const cwd = cwdOf();
  fs.mkdirSync(prdsDir(), { recursive: true });
  config.addAllowedRoot(cwd);
  for (const r of rows) {
    const dep = r.dependsOn?.length ? `dependsOn: [${r.dependsOn.join(', ')}]\n` : '';
    fs.writeFileSync(path.join(prdsDir(), `${r.slug}.md`), `---\ntitle: ${r.slug}\ncwd: ${cwd}\nestimateMinutes: 10\n${dep}---\n\n# Goal\n\nx\n`);
  }
  await scheduler.writeQueue({
    jobs: rows.map((r) => ({ slug: r.slug, title: r.slug, cwd, epicId: EPIC, status: r.status ?? 'pending', dependsOn: r.dependsOn ?? [] })),
    config: {},
    paused: null,
  });
  return cwd;
}

async function jobOf(slug) {
  const queuePath = path.join(cwdOf(), 'session-manager-operations', 'scheduler', 'state', 'queue.json');
  return JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs.find((j) => j.slug === slug);
}

function fileDeps(slug) {
  const { frontmatter } = parsePrdFile(fs.readFileSync(path.join(prdsDir(), `${slug}.md`), 'utf8'));
  return frontmatter.dependsOn ?? [];
}

function auditRows(kind) {
  try {
    return fs.readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
  } catch { return []; }
}

const CHAIN = [
  { slug: '10-target' },
  { slug: '11-a', dependsOn: ['target'] },
  { slug: '12-b', dependsOn: ['11-a'] },
  { slug: '13-keep' },
];

test('refuses without a dependents choice, listing dependents and choices; nothing changes', async () => {
  const cwd = await seed(CHAIN);
  const before = auditRows('job_cancel_dependents').length;
  const res = await scheduler.remote.cancelJob('10-target', { cwd });
  expect(res.ok).toBe(false);
  expect(res.dependents).toEqual(['11-a']);
  expect(res.choices).toEqual(['cascade', 'repoint', 'clear']);
  expect(res.error).toMatch(/11-a/);
  expect(res.error).toMatch(/cascade/);
  expect(res.error).toMatch(/repoint/);
  expect(res.error).toMatch(/clear/);
  expect((await jobOf('10-target')).status).toBe('pending');
  expect(auditRows('job_cancel_dependents').length).toBe(before);
});

test('cascade cancels the target and every pending dependent transitively', async () => {
  const cwd = await seed(CHAIN);
  const res = await scheduler.remote.cancelJob('10-target', { cwd, dependents: { action: 'cascade' } });
  expect(res.ok).toBe(true);
  for (const slug of ['10-target', '11-a', '12-b']) {
    const j = await jobOf(slug);
    expect(j.status).toBe('failed');
    expect(j.cancelledAt).toBe(res.cancelledAt);
    expect(j.statusHistory.at(-1).source).toBe('remote:cancelJob');
  }
  expect((await jobOf('11-a')).error).toMatch(/10-target/);
  expect((await jobOf('13-keep')).status).toBe('pending');
  const audit = auditRows('job_cancel_dependents').at(-1);
  expect(audit).toMatchObject({ slug: '10-target', cwd, action: 'cascade', to: null, dependents: ['11-a', '12-b'] });
});

test('repoint rewrites the dep to the full slug of `to`, then cancels the target', async () => {
  const cwd = await seed(CHAIN);
  const res = await scheduler.remote.cancelJob('10-target', { cwd, dependents: { action: 'repoint', to: 'keep' } });
  expect(res.ok).toBe(true);
  expect(fileDeps('11-a')).toEqual(['13-keep']);
  expect((await jobOf('11-a')).dependsOn).toEqual(['13-keep']);
  expect((await jobOf('11-a')).status).toBe('pending');
  expect((await jobOf('10-target')).status).toBe('failed');
  expect(auditRows('job_cancel_dependents').at(-1)).toMatchObject({ slug: '10-target', action: 'repoint', to: '13-keep', dependents: ['11-a'] });
});

test('repoint refusals abort before the target cancel', async () => {
  const cwd = await seed(CHAIN);
  for (const to of ['missing', 'target', '12-b']) {
    const res = await scheduler.remote.cancelJob('10-target', { cwd, dependents: { action: 'repoint', to } });
    expect(res.ok).toBe(false);
  }
  expect((await jobOf('10-target')).status).toBe('pending');
  expect(fileDeps('11-a')).toEqual(['target']);
});

test('a failed dependent edit aborts before the target cancel', async () => {
  const cwd = await seed(CHAIN);
  fs.rmSync(path.join(prdsDir(), '11-a.md'));
  const res = await scheduler.remote.cancelJob('10-target', { cwd, dependents: { action: 'clear' } });
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/11-a/);
  expect((await jobOf('10-target')).status).toBe('pending');
});

test('clear removes the dep, then cancels the target', async () => {
  const cwd = await seed([...CHAIN, { slug: '14-two', dependsOn: ['13-keep', '10-target'] }]);
  const res = await scheduler.remote.cancelJob('10-target', { cwd, dependents: { action: 'clear' } });
  expect(res.ok).toBe(true);
  expect(fileDeps('11-a')).toEqual([]);
  expect(fileDeps('14-two')).toEqual(['13-keep']);
  expect((await jobOf('10-target')).status).toBe('failed');
  expect(auditRows('job_cancel_dependents').at(-1)).toMatchObject({ action: 'clear', dependents: ['11-a', '14-two'] });
});

test('no pending dependents: cancel behaves as before and writes no dependents audit row', async () => {
  const cwd = await seed([{ slug: '10-target' }, { slug: '11-done', status: 'completed', dependsOn: ['target'] }]);
  const before = auditRows('job_cancel_dependents').length;
  const res = await scheduler.remote.cancelJob('10-target', { cwd });
  expect(res.ok).toBe(true);
  expect(res.status).toBe('failed');
  expect(res.dependents).toBeUndefined();
  expect(auditRows('job_cancel_dependents').length).toBe(before);
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

test('admin route: 409 on refusal, passes dependents through, 400 on a bad choice', async () => {
  const cwd = await seed(CHAIN);
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  prdAdminRoutes.registerAdminRoute(admin, scheduler.remote);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  try {
    const p = '/admin/scheduler/cancel-job';
    const refused = await request(port, { path: p, token, body: { slug: '10-target', cwd } });
    expect(refused.status).toBe(409);
    expect(refused.json.dependents).toEqual(['11-a']);
    const bad = await request(port, { path: p, token, body: { slug: '10-target', cwd, dependents: { action: 'repoint' } } });
    expect(bad.status).toBe(400);
    const ok = await request(port, { path: p, token, body: { slug: '10-target', cwd, dependents: { action: 'cascade' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.dependents).toMatchObject({ action: 'cascade', slugs: ['11-a', '12-b'] });
  } finally {
    await admin.stop();
  }
});
