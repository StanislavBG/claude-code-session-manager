/**
 * localAdminHttpInvoke.test.cjs — in-process invoke() on the admin HTTP
 * transport: runs a registered handler with an in-memory req/res (no socket,
 * no bearer token) and answers { status, json }.
 *
 * Run: timeout 120 npx vitest run src/main/lib/feedback-remote/__tests__/localAdminHttpInvoke.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const http = require('node:http');
const { createAdminHttp, readBody, sendJson } = require('../localAdminHttp.cjs');
const { contractInfo } = require('../../externalContract.cjs');

test('POST with body runs the handler and returns its JSON', async () => {
  const admin = createAdminHttp();
  let seen = null;
  admin.registerRoute('POST', '/admin/echo', async (req, res) => {
    const raw = await readBody(req);
    seen = { method: req.method, url: req.url, contentType: req.headers['content-type'] };
    const parsed = JSON.parse(raw);
    sendJson(res, 201, { ok: true, got: parsed });
  });
  const out = await admin.invoke('POST', '/admin/echo', { body: { a: 1, nested: { b: 'x' } } });
  expect(out).toEqual({ status: 201, json: { ok: true, got: { a: 1, nested: { b: 'x' } } } });
  expect(seen).toEqual({ method: 'POST', url: '/admin/echo', contentType: 'application/json' });
  // No token was ever minted, and no server was started.
  expect(admin.token).toBeNull();
  expect(admin.server).toBeNull();
});

test('GET with query hands URLSearchParams to the handler and keeps it on req.url', async () => {
  const admin = createAdminHttp();
  admin.registerRoute('GET', '/admin/list', async (req, res, query) => {
    sendJson(res, 200, { ok: true, cwd: query.get('cwd'), status: query.get('status'), keep: query.get('keep'), url: req.url });
  });
  const out = await admin.invoke('GET', '/admin/list?keep=1', { query: { cwd: '/tmp/a b', status: 'queued', skip: undefined } });
  expect(out.status).toBe(200);
  expect(out.json).toMatchObject({ ok: true, cwd: '/tmp/a b', status: 'queued', keep: '1' });
  expect(new URL(out.json.url, 'http://x').pathname).toBe('/admin/list');
});

test('unknown route answers 404 with the same keys handleRequest sends', async () => {
  const admin = createAdminHttp();
  const out = await admin.invoke('GET', '/admin/nope');
  const { appVersion, contractVersion } = contractInfo();
  expect(out).toEqual({
    status: 404,
    json: {
      ok: false,
      error: 'not found',
      unknownRoute: 'GET /admin/nope',
      appVersion: appVersion ?? null,
      contractVersion,
    },
  });
});

test('a handler throw answers 500 { ok:false, error }', async () => {
  const admin = createAdminHttp();
  admin.registerRoute('POST', '/admin/boom', async () => { throw new Error('kaboom'); });
  const out = await admin.invoke('POST', '/admin/boom', { body: {} });
  expect(out).toEqual({ status: 500, json: { ok: false, error: 'kaboom' } });
});

test('invoke opens no socket', async () => {
  const admin = createAdminHttp();
  admin.registerRoute('GET', '/admin/ping', async (req, res) => sendJson(res, 200, { ok: true }));
  const createServer = vi.spyOn(http, 'createServer');
  const request = vi.spyOn(http, 'request');
  try {
    const out = await admin.invoke('GET', '/admin/ping');
    expect(out).toEqual({ status: 200, json: { ok: true } });
    expect(createServer).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally {
    createServer.mockRestore();
    request.mockRestore();
  }
});
