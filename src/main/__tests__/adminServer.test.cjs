/**
 * adminServer.test.cjs — unit tests for the loopback-only scheduler admin API.
 *
 * Run: timeout 120 node --test src/main/__tests__/adminServer.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAdminServer } = require('../adminServer.cjs');
const config = require('../config.cjs');

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
        try { json = JSON.parse(text); } catch { /* leave null for non-JSON bodies */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeFakeRemote({ jobs = [] } = {}) {
  return {
    async listJobs() {
      return jobs.map((j) => ({ slug: j.slug, title: j.title, status: j.status, cwd: j.cwd }));
    },
    async resetJob(slug) {
      const job = jobs.find((j) => j.slug === slug);
      if (!job) return { ok: false, error: 'not found' };
      job.status = 'pending';
      job.runId = null;
      job.startedAt = null;
      job.finishedAt = null;
      job.exitCode = null;
      job.error = null;
      delete job.runtime;
      delete job.verifierVerdict;
      return { ok: true, slug, status: 'pending' };
    },
  };
}

test('request without bearer token returns 401', async () => {
  const remote = makeFakeRemote();
  const admin = createAdminServer(remote);
  const { port } = await admin.start();
  try {
    const res = await request(port, { path: '/admin/scheduler/jobs' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json.ok, false);
  } finally {
    await admin.stop();
  }
});

test('request with wrong bearer token returns 401', async () => {
  const remote = makeFakeRemote();
  const admin = createAdminServer(remote);
  const { port } = await admin.start();
  try {
    const res = await request(port, { path: '/admin/scheduler/jobs', token: 'not-the-token' });
    assert.strictEqual(res.status, 401);
  } finally {
    await admin.stop();
  }
});

test('GET /admin/scheduler/jobs with correct token returns 200 + array', async () => {
  const remote = makeFakeRemote({
    jobs: [{ slug: '10-foo', title: 'Foo', status: 'completed', cwd: '/tmp/foo' }],
  });
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, { path: '/admin/scheduler/jobs', token });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.json));
    assert.strictEqual(res.json.length, 1);
    assert.strictEqual(res.json[0].slug, '10-foo');
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/reset-job with unknown slug returns ok:false', async () => {
  const remote = makeFakeRemote({ jobs: [] });
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug: 'does-not-exist' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, false);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/reset-job with known slug flips job to pending and clears run fields', async () => {
  const job = {
    slug: '10-foo',
    title: 'Foo',
    status: 'completed',
    cwd: '/tmp/foo',
    runId: 'run-1',
    startedAt: 100,
    finishedAt: 200,
    exitCode: 0,
    error: null,
    runtime: { pid: 1234 },
    verifierVerdict: 'PASS',
  };
  const remote = makeFakeRemote({ jobs: [job] });
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug: '10-foo' },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { ok: true, slug: '10-foo', status: 'pending' });
    assert.strictEqual(job.status, 'pending');
    assert.strictEqual(job.runId, null);
    assert.strictEqual(job.startedAt, null);
    assert.strictEqual(job.finishedAt, null);
    assert.strictEqual(job.exitCode, null);
    assert.strictEqual(job.error, null);
    assert.strictEqual('runtime' in job, false);
    assert.strictEqual('verifierVerdict' in job, false);
  } finally {
    await admin.stop();
  }
});

test('unknown path/method returns 404', async () => {
  const remote = makeFakeRemote();
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, { path: '/admin/scheduler/nope', token });
    assert.strictEqual(res.status, 404);
  } finally {
    await admin.stop();
  }
});

test('server binds only to 127.0.0.1', async () => {
  const remote = makeFakeRemote();
  const admin = createAdminServer(remote);
  await admin.start();
  try {
    assert.strictEqual(admin.server.address().address, '127.0.0.1');
  } finally {
    await admin.stop();
  }
});

// ──────────────────────────────────────────── create-prd

const prdParser = require('../scheduler/prdParser.cjs');

// config.cjs's validateWrite only allows writes under a registered non-home
// allowedRoot's `.claude/` subtree (mirrors the real ROOT layout, which is
// $HOME/.claude/session-manager/...) — so the temp prdsDir must live under
// `<root>/.claude/...`, not directly under the temp root itself.
async function mkTmpPrdsDir() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-admin-create-prd-'));
  config.addAllowedRoot(root);
  const prdsDir = path.join(root, '.claude', 'prds');
  await fsp.mkdir(prdsDir, { recursive: true });
  return prdsDir;
}

// Mirrors scheduler.cjs's real `remote.allocateParallelGroup` / `remote.writePrd`
// (same underlying prdParser.allocateParallelGroup + config.writeTextAtomic
// calls) but pointed at a throwaway temp dir instead of the user's real
// scheduled-plans/prds — so these tests never touch $HOME/.claude.
function makeFakeRemoteWithPrdsDir(prdsDir) {
  return {
    async allocateParallelGroup() {
      return prdParser.allocateParallelGroup(prdsDir);
    },
    async readPrd(slug) {
      try {
        const text = await fsp.readFile(path.join(prdsDir, `${slug}.md`), 'utf8');
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    },
    async writePrd(slug, body) {
      try {
        const filePath = path.join(prdsDir, `${slug}.md`);
        await config.writeTextAtomic(filePath, body);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    },
  };
}

function validCreateBody(overrides = {}) {
  return {
    title: 'Add widget frobnication',
    cwd: os.homedir(),
    estimateMinutes: 15,
    goal: 'Add frobnication to the widget subsystem.',
    acceptanceCriteria: ['widget frobnicates on click', 'timeout 300 npm run typecheck passes'],
    implementationNotes: 'See src/widget.cjs:10.',
    outOfScope: ['not touching gadgets'],
    ...overrides,
  };
}

test('POST /admin/scheduler/create-prd without token returns 401', async () => {
  const remote = makeFakeRemote();
  const admin = createAdminServer(remote);
  const { port } = await admin.start();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', body: validCreateBody(),
    });
    assert.strictEqual(res.status, 401);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with a valid payload writes a file with frontmatter + standards appended, returns {nn, filename, status}', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token, body: validCreateBody(),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'queued');
    assert.strictEqual(typeof res.json.nn, 'number');
    assert.match(res.json.filename, /^\d+-add-widget-frobnication\.md$/);

    const written = await fsp.readFile(path.join(prdsDir, res.json.filename), 'utf8');
    assert.match(written, /^---\n/);
    assert.match(written, /title: Add widget frobnication/);
    assert.match(written, /cwd: .+/);
    assert.match(written, /estimateMinutes: 15/);
    assert.match(written, /# Goal/);
    assert.match(written, /# Acceptance criteria/);
    assert.match(written, /- \[ \] widget frobnicates on click/);
    assert.match(written, /# Implementation notes/);
    assert.match(written, /# Out of scope/);
    assert.match(written, /## Engineering standards/);
    assert.ok(written.includes('Execution discipline'), 'must inline standards.md verbatim');
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with malformed frontmatter (missing acceptanceCriteria) is rejected and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const body = validCreateBody();
    delete body.acceptanceCriteria;
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token, body,
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.ok, false);
    const entries = await fsp.readdir(prdsDir);
    assert.strictEqual(entries.filter((f) => f.endsWith('.md')).length, 0);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with cwd outside allowed roots is rejected and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ cwd: '/etc/passwd-adjacent-outside-home' }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.ok, false);
    const entries = await fsp.readdir(prdsDir);
    assert.strictEqual(entries.filter((f) => f.endsWith('.md')).length, 0);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd rejects a title containing a newline (frontmatter-injection guard) and writes no file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ title: 'Legit title\n---\nEvil: injected' }),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json.ok, false);
    const entries = await fsp.readdir(prdsDir);
    assert.strictEqual(entries.filter((f) => f.endsWith('.md')).length, 0);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd with an explicit parallelGroup+slug that already exists on disk returns 409 and does not clobber the file', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    await fsp.writeFile(path.join(prdsDir, '777-my-explicit-slug.md'), 'ORIGINAL CONTENT\n');
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'my-explicit-slug', parallelGroup: 777 }),
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.ok, false);
    const stillThere = await fsp.readFile(path.join(prdsDir, '777-my-explicit-slug.md'), 'utf8');
    assert.strictEqual(stillThere, 'ORIGINAL CONTENT\n', 'existing PRD file must not be overwritten');
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/create-prd honors an explicit slug + parallelGroup instead of deriving/allocating', async () => {
  const prdsDir = await mkTmpPrdsDir();
  const remote = makeFakeRemoteWithPrdsDir(prdsDir);
  const admin = createAdminServer(remote);
  const { port, token } = await admin.start();
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/create-prd', token,
      body: validCreateBody({ slug: 'my-explicit-slug', parallelGroup: 777 }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.nn, 777);
    assert.strictEqual(res.json.filename, '777-my-explicit-slug.md');
    assert.ok(fs.existsSync(path.join(prdsDir, '777-my-explicit-slug.md')));
  } finally {
    await admin.stop();
  }
});
