/**
 * localAdminHttp.test.cjs — unit tests for the generic loopback-only HTTP
 * transport (PRD 689 — extracted from the former standalone admin HTTP server
 * module). Covers
 * only transport concerns: auth rejection, token persistence, route dispatch,
 * and 404 on unknown routes. Route *logic* tests live beside their owning
 * module (scheduler.cjs's admin routes, prdCreate.cjs's create-prd route).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/localAdminHttp.test.cjs
 */

'use strict';

import { test, expect, afterAll } from 'vitest';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAdminHttp, TOKEN_PATH, resolveTokenPath } = require('../localAdminHttp.cjs');

// Redirect every start() in this file away from the PRODUCTION admin-api.json.
// Without this, these tests overwrote the running app's port+token with a
// throwaway server's, orphaning scheduler-mcp-server.cjs until an app restart
// (confirmed live 2026-08-01). Tests that specifically exercise path
// resolution unset this override themselves.
// Must live under the home dir: config.writeJson enforces allowedRoots.
const TEST_TOKEN_PATH = path.join(path.dirname(TOKEN_PATH), `admin-api.test-${process.pid}.json`);
process.env.SM_ADMIN_TOKEN_PATH = TEST_TOKEN_PATH;

afterAll(() => { fs.rmSync(TEST_TOKEN_PATH, { force: true }); });

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

test('request without bearer token returns 401', async () => {
  const admin = createAdminHttp();
  admin.registerRoute('GET', '/ping', async (req, res) => { res.writeHead(200); res.end('{}'); });
  const { port } = await admin.start();
  try {
    const res = await request(port, { path: '/ping' });
    expect(res.status).toBe(401);
    expect(res.json.ok).toBe(false);
  } finally {
    await admin.stop();
  }
});

test('request with wrong bearer token returns 401', async () => {
  const admin = createAdminHttp();
  admin.registerRoute('GET', '/ping', async (req, res) => { res.writeHead(200); res.end('{}'); });
  const { port } = await admin.start();
  try {
    const res = await request(port, { path: '/ping', token: 'not-the-token' });
    expect(res.status).toBe(401);
  } finally {
    await admin.stop();
  }
});

test('registered route with correct token is dispatched', async () => {
  const admin = createAdminHttp();
  admin.registerRoute('GET', '/ping', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pong: true }));
  });
  const { port, token } = await admin.start();
  try {
    const res = await request(port, { path: '/ping', token });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, pong: true });
  } finally {
    await admin.stop();
  }
});

test('unregistered path/method returns 404', async () => {
  const admin = createAdminHttp();
  const { port, token } = await admin.start();
  try {
    const res = await request(port, { path: '/nope', token });
    expect(res.status).toBe(404);
  } finally {
    await admin.stop();
  }
});

test('server binds only to 127.0.0.1', async () => {
  const admin = createAdminHttp();
  await admin.start();
  try {
    expect(admin.server.address().address).toBe('127.0.0.1');
  } finally {
    await admin.stop();
  }
});

test('start() persists token file with port + token, mode 0600', async () => {
  const admin = createAdminHttp();
  const { port, token } = await admin.start();
  try {
    const raw = fs.readFileSync(TEST_TOKEN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.port).toBe(port);
    expect(parsed.token).toBe(token);
    const mode = fs.statSync(TEST_TOKEN_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  } finally {
    await admin.stop();
  }
});

test('SM_DEV=1 writes to a dev-suffixed path, never the production admin-api.json', async () => {
  const devPath = path.join(path.dirname(TOKEN_PATH), 'admin-api.dev.json');
  const prevMtime = fs.existsSync(TOKEN_PATH) ? fs.statSync(TOKEN_PATH).mtimeMs : null;
  const prevEnv = process.env.SM_DEV;
  const prevOverride = process.env.SM_ADMIN_TOKEN_PATH;
  delete process.env.SM_ADMIN_TOKEN_PATH;
  process.env.SM_DEV = '1';
  const admin = createAdminHttp();
  try {
    const { port, token } = await admin.start();
    expect(resolveTokenPath()).toBe(devPath);
    const parsed = JSON.parse(fs.readFileSync(devPath, 'utf8'));
    expect(parsed.port).toBe(port);
    expect(parsed.token).toBe(token);
    // Production file must be untouched by the dev-mode instance.
    if (prevMtime !== null) {
      expect(fs.statSync(TOKEN_PATH).mtimeMs).toBe(prevMtime);
    } else {
      expect(fs.existsSync(TOKEN_PATH)).toBe(false);
    }
  } finally {
    await admin.stop();
    if (prevEnv === undefined) delete process.env.SM_DEV; else process.env.SM_DEV = prevEnv;
    if (prevOverride !== undefined) process.env.SM_ADMIN_TOKEN_PATH = prevOverride;
    fs.rmSync(devPath, { force: true });
  }
});

test('with neither SM_DEV nor SM_E2E set, resolves to the original admin-api.json path', () => {
  // Path RESOLUTION only — deliberately does not start() a server here. This
  // test used to boot one with no override set, which wrote a throwaway
  // port+token straight into the live app's admin-api.json and cut
  // scheduler-mcp-server.cjs off from the running app. Persistence itself is
  // covered by the 0600 test above, against the redirected test path.
  const prevDev = process.env.SM_DEV;
  const prevE2e = process.env.SM_E2E;
  const prevOverride = process.env.SM_ADMIN_TOKEN_PATH;
  delete process.env.SM_DEV;
  delete process.env.SM_E2E;
  delete process.env.SM_ADMIN_TOKEN_PATH;
  try {
    expect(resolveTokenPath()).toBe(TOKEN_PATH);
  } finally {
    if (prevDev === undefined) delete process.env.SM_DEV; else process.env.SM_DEV = prevDev;
    if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
    if (prevOverride !== undefined) process.env.SM_ADMIN_TOKEN_PATH = prevOverride;
  }
});

test('dev and production token paths never collide', () => {
  const prevEnv = process.env.SM_DEV;
  const prevOverride = process.env.SM_ADMIN_TOKEN_PATH;
  delete process.env.SM_ADMIN_TOKEN_PATH;
  try {
    process.env.SM_DEV = '1';
    const devPath = resolveTokenPath();
    delete process.env.SM_DEV;
    const prodPath = resolveTokenPath();
    expect(devPath).not.toBe(prodPath);
  } finally {
    if (prevEnv === undefined) delete process.env.SM_DEV; else process.env.SM_DEV = prevEnv;
    if (prevOverride !== undefined) process.env.SM_ADMIN_TOKEN_PATH = prevOverride;
  }
});

test('start()s self-check answers on the health path with the fresh bearer token', async () => {
  const admin = createAdminHttp();
  const { port, token } = await admin.start();
  try {
    const res = await request(port, { path: '/__admin/health', token });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  } finally {
    await admin.stop();
  }
});
