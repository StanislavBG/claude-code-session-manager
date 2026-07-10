/**
 * adminServer.test.cjs — unit tests for the loopback-only scheduler admin API.
 *
 * Run: timeout 120 node --test src/main/__tests__/adminServer.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdminServer } = require('../adminServer.cjs');

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
