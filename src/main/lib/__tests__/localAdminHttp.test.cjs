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

import { test, expect } from 'vitest';
const http = require('node:http');
const fs = require('node:fs');
const { createAdminHttp, TOKEN_PATH } = require('../localAdminHttp.cjs');

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
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.port).toBe(port);
    expect(parsed.token).toBe(token);
    const mode = fs.statSync(TOKEN_PATH).mode & 0o777;
    expect(mode).toBe(0o600);
  } finally {
    await admin.stop();
  }
});
