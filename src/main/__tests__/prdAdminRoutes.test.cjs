/**
 * prdAdminRoutes.test.cjs — unit tests for PRD 1024's admin HTTP routes
 * (list/get/update/archive/cancel/retag) and the scheduler.cjs `remote`
 * methods they delegate to. Exercises real HTTP round-trips against a real
 * (temp-HOME) filesystem, matching prdCreate.test.cjs's pattern for the
 * create-prd route.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let tmpHome;
let originalHome;
let scheduler;
let prdAdminRoutes;
let config;
let createAdminHttp;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-admin-prd-routes-'));
  process.env.HOME = tmpHome;

  // Load AFTER HOME is stubbed — scheduler.cjs/config.cjs snapshot
  // os.homedir() into module-level constants at load time, not lazily.
  scheduler = require('../scheduler.cjs');
  prdAdminRoutes = require('../lib/prdAdminRoutes.cjs');
  config = require('../config.cjs');
  ({ createAdminHttp } = require('../lib/localAdminHttp.cjs'));

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }

  // allProjectCwds()/activeProjectCwds() (queueStore.cjs's stateCwds, and
  // prdLocations.cjs's resolvePrdsDirs) discover project cwds by scanning
  // ~/.claude/projects/*/*.jsonl for a `cwd` field — fake one project
  // transcript pointing at the real on-disk fixture cwd this file uses,
  // same pattern as scheduler-verify-prd-path.test.cjs.
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'session.jsonl'),
    `${JSON.stringify({ cwd: path.join(tmpHome, 'fake-project-cwd') })}\n`,
    'utf8',
  );
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function projectCwd() {
  const cwd = path.join(tmpHome, 'fake-project-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  config.addAllowedRoot(cwd);
  return cwd;
}

function uniqueSlug(prefix) {
  return `${prefix}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
}

async function writePrdFixture({ cwd, epicId, slug, extra = '' }) {
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  const filePath = path.join(prdsDir, `${slug}.md`);
  const body = `---\ntitle: fixture title\ncwd: ${cwd}\nestimateMinutes: 10\n${extra}---\n\n# Goal\n\ndo the thing\n`;
  await fsp.writeFile(filePath, body, 'utf8');
  return filePath;
}

function request(port, { method = 'GET', path: reqPath, token, body }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function startAdmin() {
  const prevE2e = process.env.SM_E2E;
  process.env.SM_E2E = '1';
  const admin = createAdminHttp();
  prdAdminRoutes.registerAdminRoute(admin, scheduler.remote);
  // Also wires reset-job/jobs (scheduler.cjs's own admin routes) onto the
  // SAME admin instance/port, against the real (not faked) `remote` — this
  // file's real-filesystem setup is what the reset-job/cancel-job/archive-prd
  // slug-vs-not-found split needs, unlike scheduler-admin-routes.test.cjs's
  // fake remote.
  scheduler.registerAdminRoutes(admin, scheduler.remote);
  const { port, token } = await admin.start();
  if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  return { admin, port, token };
}

test('GET /admin/scheduler/prds without token returns 401', async () => {
  const { admin, port } = await startAdmin();
  try {
    const res = await request(port, { path: '/admin/scheduler/prds' });
    expect(res.status).toBe(401);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prds lists a live PRD with status null (no queue row yet), filterable by cwd', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-list';
  const slug = uniqueSlug('list-prds');
  await writePrdFixture({ cwd, epicId, slug });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { path: `/admin/scheduler/prds?cwd=${encodeURIComponent(cwd)}`, token });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const entry = res.json.prds.find((p) => p.slug === slug);
    expect(entry).toBeTruthy();
    expect(entry.status).toBe(null);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prds defaults to limit=100/offset=0, reports total/hasMore, omits secondary fields', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-list-defaults';
  const slug = uniqueSlug('list-prds-defaults');
  await writePrdFixture({ cwd, epicId, slug });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { path: `/admin/scheduler/prds?cwd=${encodeURIComponent(cwd)}`, token });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.limit).toBe(100);
    expect(res.json.offset).toBe(0);
    expect(res.json.total).toBe(res.json.prds.length);
    expect(res.json.hasMore).toBe(false);
    const entry = res.json.prds.find((p) => p.slug === slug);
    expect(entry).toBeTruthy();
    expect('epicId' in entry).toBe(false);
    expect('sourcePromptId' in entry).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prds?fields=full restores secondary fields', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-list-full';
  const slug = uniqueSlug('list-prds-full');
  await writePrdFixture({ cwd, epicId, slug });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { path: `/admin/scheduler/prds?cwd=${encodeURIComponent(cwd)}&fields=full`, token });
    expect(res.status).toBe(200);
    const entry = res.json.prds.find((p) => p.slug === slug);
    expect(entry.epicId).toBe(epicId);
    expect(entry.sourcePromptId).toBeTruthy();
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prds pages disjointly by limit/offset in stable slug order', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-list-paged';
  const base = uniqueSlug('list-prds-paged');
  const slugs = [];
  for (let i = 0; i < 5; i++) {
    const slug = `${base}-${i}`;
    slugs.push(slug);
    await writePrdFixture({ cwd, epicId, slug });
  }

  const { admin, port, token } = await startAdmin();
  try {
    const qs = `cwd=${encodeURIComponent(cwd)}&epicId=${encodeURIComponent(epicId)}`;
    const page1 = await request(port, { path: `/admin/scheduler/prds?${qs}&limit=2&offset=0`, token });
    const page2 = await request(port, { path: `/admin/scheduler/prds?${qs}&limit=2&offset=2`, token });
    const page3 = await request(port, { path: `/admin/scheduler/prds?${qs}&limit=2&offset=4`, token });

    expect(page1.json.prds).toHaveLength(2);
    expect(page1.json.total).toBe(5);
    expect(page1.json.hasMore).toBe(true);
    expect(page2.json.prds).toHaveLength(2);
    expect(page2.json.hasMore).toBe(true);
    expect(page3.json.prds).toHaveLength(1);
    expect(page3.json.hasMore).toBe(false);

    const seenSlugs = [...page1.json.prds, ...page2.json.prds, ...page3.json.prds].map((p) => p.slug);
    expect(new Set(seenSlugs).size).toBe(5);
    const expectedOrder = [...seenSlugs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    expect(seenSlugs).toEqual(expectedOrder);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prds rejects limit over the hard max with a 400', async () => {
  const cwd = projectCwd();
  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { path: `/admin/scheduler/prds?cwd=${encodeURIComponent(cwd)}&limit=501`, token });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prds rejects a negative offset with a 400', async () => {
  const cwd = projectCwd();
  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { path: `/admin/scheduler/prds?cwd=${encodeURIComponent(cwd)}&offset=-1`, token });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prd?slug=&cwd= returns parsed frontmatter + body', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-get';
  const slug = uniqueSlug('get-prd');
  await writePrdFixture({ cwd, epicId, slug });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { path: `/admin/scheduler/prd?slug=${slug}&cwd=${encodeURIComponent(cwd)}`, token });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.frontmatter.title).toBe('fixture title');
    expect(res.json.body).toMatch(/do the thing/);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/prd for a nonexistent slug returns 404', async () => {
  const cwd = projectCwd();
  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { path: `/admin/scheduler/prd?slug=${uniqueSlug('nope')}&cwd=${encodeURIComponent(cwd)}`, token });
    expect(res.status).toBe(404);
    expect(res.json.ok).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/update-prd edits a not-yet-queued PRD and preserves unrecognized frontmatter keys', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-update';
  const slug = uniqueSlug('update-prd');
  await writePrdFixture({ cwd, epicId, slug, extra: 'dependsOn: [some-other-slug]\n' });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/update-prd', token,
      body: { slug, cwd, frontmatter: { title: 'edited title', estimateMinutes: 25 } },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    const raw = await fsp.readFile(path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds', `${slug}.md`), 'utf8');
    expect(raw).toMatch(/title: edited title/);
    expect(raw).toMatch(/estimateMinutes: 25/);
    // Unrecognized key round-trips verbatim.
    expect(raw).toMatch(/dependsOn: \[some-other-slug\]/);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/update-prd refuses a slug whose job is running, naming the current status', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-update-running';
  const slug = uniqueSlug('update-prd-running');
  await writePrdFixture({ cwd, epicId, slug });

  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'running', runtime: {} }],
    config: {},
    paused: null,
  });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/update-prd', token,
      body: { slug, cwd, frontmatter: { title: 'should not land' } },
    });
    expect(res.status).toBe(409);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toMatch(/running/);
  } finally {
    await admin.stop();
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('POST /admin/scheduler/cancel-job cancels a pending job (no cancelled status exists — lands as failed)', async () => {
  const cwd = projectCwd();
  const slug = uniqueSlug('cancel-pending');
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending' }],
    config: {},
    paused: null,
  });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { method: 'POST', path: '/admin/scheduler/cancel-job', token, body: { slug } });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.status).toBe('failed');
    expect(res.json.wasRunning).toBe(false);
  } finally {
    await admin.stop();
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('POST /admin/scheduler/cancel-job refuses an already-terminal job', async () => {
  const cwd = projectCwd();
  const slug = uniqueSlug('cancel-terminal');
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'completed' }],
    config: {},
    paused: null,
  });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { method: 'POST', path: '/admin/scheduler/cancel-job', token, body: { slug } });
    expect(res.status).toBe(409);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toMatch(/terminal/);
  } finally {
    await admin.stop();
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('POST /admin/scheduler/archive-prd moves a PRD to prds-archived/', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-archive';
  const slug = uniqueSlug('archive-prd');
  const filePath = await writePrdFixture({ cwd, epicId, slug });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, { method: 'POST', path: '/admin/scheduler/archive-prd', token, body: { slugs: [slug] } });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.archived).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);
  } finally {
    await admin.stop();
  }
});

// ─────────────────────────────────────── invalid-slug vs unknown-slug split
//
// PRD: safeSlugPath used to collapse "malformed slug" and "well-formed slug
// found nowhere" into the same `null` -> "invalid slug" response, so an
// agent that typed a real slug for a PRD in the wrong project (or a since-
// archived one) read the error as "I typed it wrong" and retried instead of
// listing PRDs. These tests pin the split for all three verbs plus the new
// optional `cwd` narrowing.

test('POST /admin/scheduler/reset-job with a malformed slug returns "invalid slug"', async () => {
  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug: 'not a slug!!' },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toBe('invalid slug');
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/reset-job with a well-formed slug that exists nowhere returns a distinct unknown-slug error', async () => {
  const { admin, port, token } = await startAdmin();
  try {
    const slug = uniqueSlug('definitely-not-a-real-prd');
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).not.toBe('invalid slug');
    expect(res.json.error).toMatch(/unknown slug/);
    expect(res.json.error).toMatch(/scheduler_list_prds/);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/reset-job with a cwd naming a project with no PRD dir yields the unknown-slug error, not a crash', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-reset-cwd-miss';
  const slug = uniqueSlug('reset-cwd-miss');
  await writePrdFixture({ cwd, epicId, slug }); // exists under `cwd`, not under `otherCwd`

  const otherCwd = path.join(tmpHome, 'fake-project-cwd-empty');
  fs.mkdirSync(otherCwd, { recursive: true });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug, cwd: otherCwd },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toMatch(/unknown slug/);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/reset-job with a matching cwd resets a known job', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-reset-cwd-hit';
  const slug = uniqueSlug('reset-cwd-hit');
  await writePrdFixture({ cwd, epicId, slug });
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'needs_review' }],
    config: {},
    paused: null,
  });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug, cwd },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, slug, status: 'pending' });
  } finally {
    await admin.stop();
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('POST /admin/scheduler/reset-job with cwd resets the SAME-slug job belonging to that project, not a same-slug job from another project (cwd narrows the job lookup, not just the file lookup)', async () => {
  // Slugs derive from title text with no cwd salt, so two different projects
  // can legitimately queue an identically-slugged job. `cwd` must disambiguate
  // which one gets reset, not just which PRD file gets read for existence.
  const cwdA = projectCwd();
  const cwdB = path.join(tmpHome, 'fake-project-cwd-collision-b');
  fs.mkdirSync(cwdB, { recursive: true });
  config.addAllowedRoot(cwdB);
  // queueStore.cjs's readMerged only reads back a project's shard if that
  // project's cwd is discoverable via allProjectCwds (scans ~/.claude/projects/
  // *.jsonl for a `cwd` field) — same fake-transcript trick beforeAll used for
  // the shared fixture cwd.
  const projDirB = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug-b');
  fs.mkdirSync(projDirB, { recursive: true });
  fs.writeFileSync(path.join(projDirB, 'session.jsonl'), `${JSON.stringify({ cwd: cwdB })}\n`, 'utf8');
  const { bustCwdCache } = require('../lib/queueStore.cjs');
  bustCwdCache();
  const slug = uniqueSlug('collision-slug');
  const epicId = 'epic-reset-collision';
  await writePrdFixture({ cwd: cwdB, epicId, slug });
  await scheduler.writeQueue({
    jobs: [
      { slug, title: 'project A job', cwd: cwdA, status: 'needs_review' },
      { slug, title: 'project B job', cwd: cwdB, status: 'needs_review' },
    ],
    config: {},
    paused: null,
  });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug, cwd: cwdB },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, slug, status: 'pending' });

    const state = await scheduler.remote.listJobs();
    const jobA = state.find((j) => j.cwd === cwdA);
    const jobB = state.find((j) => j.cwd === cwdB);
    expect(jobA.status).toBe('needs_review'); // untouched
    expect(jobB.status).toBe('pending'); // the one actually targeted
  } finally {
    await admin.stop();
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('POST /admin/scheduler/cancel-job with a malformed slug is rejected at the request-schema layer (400) — never reaches "not found"', async () => {
  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/cancel-job', token, body: { slug: 'not a slug!!' },
    });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).not.toMatch(/unknown slug|not found/i);
  } finally {
    await admin.stop();
  }
});

test('remote.cancelJob itself (bypassing the HTTP schema layer) returns "invalid slug" for a malformed slug, distinct from "unknown slug"', async () => {
  const malformed = await scheduler.remote.cancelJob('not a slug!!');
  expect(malformed).toEqual({ ok: false, error: 'invalid slug' });

  const wellFormedMissing = await scheduler.remote.cancelJob(uniqueSlug('cancel-remote-missing'));
  expect(wellFormedMissing.ok).toBe(false);
  expect(wellFormedMissing.error).not.toBe('invalid slug');
  expect(wellFormedMissing.error).toMatch(/unknown slug/);
});

test('POST /admin/scheduler/cancel-job with a well-formed slug that has no queued job returns a distinct unknown-slug error (404)', async () => {
  const { admin, port, token } = await startAdmin();
  try {
    const slug = uniqueSlug('cancel-missing');
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/cancel-job', token, body: { slug },
    });
    expect(res.status).toBe(404);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).not.toBe('invalid slug');
    expect(res.json.error).toMatch(/unknown slug/);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/cancel-job with cwd narrows job lookup to that project', async () => {
  const cwd = projectCwd();
  const slug = uniqueSlug('cancel-cwd-scope');
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending' }],
    config: {},
    paused: null,
  });
  const otherCwd = path.join(tmpHome, 'fake-project-cwd-cancel-miss');
  fs.mkdirSync(otherCwd, { recursive: true });

  const { admin, port, token } = await startAdmin();
  try {
    const missRes = await request(port, {
      method: 'POST', path: '/admin/scheduler/cancel-job', token, body: { slug, cwd: otherCwd },
    });
    expect(missRes.status).toBe(404);
    expect(missRes.json.ok).toBe(false);

    const hitRes = await request(port, {
      method: 'POST', path: '/admin/scheduler/cancel-job', token, body: { slug, cwd },
    });
    expect(hitRes.status).toBe(200);
    expect(hitRes.json.ok).toBe(true);
  } finally {
    await admin.stop();
    await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
  }
});

test('POST /admin/scheduler/archive-prd with a malformed slug is rejected at the request-schema layer (400) — never reaches "not found"', async () => {
  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/archive-prd', token, body: { slugs: ['not a slug!!'] },
    });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('queueOps.archiveMany itself (bypassing the HTTP schema layer) splits "invalid slug" from "not found in any PRDs dir"', async () => {
  const queueOps = require('../queueOps.cjs');
  const malformed = await queueOps.archiveMany(['not a slug!!']);
  expect(malformed.results[0]).toMatchObject({ ok: false, error: 'invalid slug' });

  const missing = await queueOps.archiveMany([uniqueSlug('archive-remote-missing')]);
  expect(missing.results[0]).toMatchObject({ ok: false, error: 'not found in any PRDs dir' });
});

test('POST /admin/scheduler/archive-prd with a well-formed slug found nowhere returns a distinct not-found error', async () => {
  const { admin, port, token } = await startAdmin();
  try {
    const slug = uniqueSlug('archive-missing');
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/archive-prd', token, body: { slugs: [slug] },
    });
    expect(res.status).toBe(200);
    expect(res.json.results[0].ok).toBe(false);
    expect(res.json.results[0].error).toBe('not found in any PRDs dir');
    expect(res.json.results[0].error).not.toBe('invalid slug');
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/archive-prd with cwd narrows the search: a cwd with no PRD dir misses, the real cwd hits', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-archive-cwd';
  const slug = uniqueSlug('archive-cwd-scope');
  const filePath = await writePrdFixture({ cwd, epicId, slug });

  const otherCwd = path.join(tmpHome, 'fake-project-cwd-archive-miss');
  fs.mkdirSync(otherCwd, { recursive: true });

  const { admin, port, token } = await startAdmin();
  try {
    const missRes = await request(port, {
      method: 'POST', path: '/admin/scheduler/archive-prd', token, body: { slugs: [slug], cwd: otherCwd },
    });
    expect(missRes.json.results[0].ok).toBe(false);
    expect(missRes.json.results[0].error).toBe('not found in any PRDs dir');
    expect(fs.existsSync(filePath)).toBe(true);

    const hitRes = await request(port, {
      method: 'POST', path: '/admin/scheduler/archive-prd', token, body: { slugs: [slug], cwd },
    });
    expect(hitRes.json.results[0].ok).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/retag-prd rewrites estimateMinutes frontmatter', async () => {
  const cwd = projectCwd();
  const epicId = 'epic-retag';
  const slug = uniqueSlug('retag-prd');
  const filePath = await writePrdFixture({ cwd, epicId, slug });

  const { admin, port, token } = await startAdmin();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/retag-prd', token,
      body: { items: [{ slug, estimateMinutes: 42 }] },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.retagged).toBe(1);
    const raw = await fsp.readFile(filePath, 'utf8');
    expect(raw).toMatch(/estimateMinutes: 42/);
  } finally {
    await admin.stop();
  }
});
