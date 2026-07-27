/**
 * scheduler-admin-routes.test.cjs — unit tests for scheduler.cjs's
 * registerAdminRoutes (PRD 689 — moved out of the former standalone admin
 * HTTP server module's handleRequest, no behavior change). Exercises the
 * two job-management admin
 * HTTP routes against a fake `remote` object, wired through the real
 * localAdminHttp.cjs transport.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-admin-routes.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const http = require('node:http');
const { createAdminHttp } = require('../lib/localAdminHttp.cjs');
const { registerAdminRoutes } = require('../scheduler.cjs');

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

async function startWithRemote(remote) {
  const admin = createAdminHttp();
  registerAdminRoutes(admin, remote);
  const { port, token } = await admin.start();
  return { admin, port, token };
}

test('GET /admin/scheduler/jobs with correct token returns 200 + array', async () => {
  const remote = makeFakeRemote({
    jobs: [{ slug: '10-foo', title: 'Foo', status: 'completed', cwd: '/tmp/foo' }],
  });
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, { path: '/admin/scheduler/jobs', token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBeTruthy();
    expect(res.json.length).toBe(1);
    expect(res.json[0].slug).toBe('10-foo');
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/reset-job with unknown slug returns ok:false', async () => {
  const remote = makeFakeRemote({ jobs: [] });
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug: 'does-not-exist' },
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('POST /admin/scheduler/reset-job without slug returns 400', async () => {
  const remote = makeFakeRemote({ jobs: [] });
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: {},
    });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
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
  const { admin, port, token } = await startWithRemote(remote);
  try {
    const res = await request(port, {
      method: 'POST', path: '/admin/scheduler/reset-job', token, body: { slug: '10-foo' },
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, slug: '10-foo', status: 'pending' });
    expect(job.status).toBe('pending');
    expect(job.runId).toBe(null);
    expect(job.startedAt).toBe(null);
    expect(job.finishedAt).toBe(null);
    expect(job.exitCode).toBe(null);
    expect(job.error).toBe(null);
    expect('runtime' in job).toBe(false);
    expect('verifierVerdict' in job).toBe(false);
  } finally {
    await admin.stop();
  }
});
