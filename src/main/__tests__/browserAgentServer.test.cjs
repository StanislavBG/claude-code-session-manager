/**
 * browserAgentServer.test.cjs — unit tests for the loopback-only browser
 * agent HTTP API (PRD 535).
 *
 * Run: timeout 120 node --test src/main/__tests__/browserAgentServer.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowserAgentServer, TOKEN_PATH, resolveTokenPath } = require('../browserAgentServer.cjs');

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

function makeFakeRemote() {
  const actions = [];
  return {
    actions,
    async listTabs() {
      return [{ viewId: 'v1', url: 'https://example.com', title: 'Example', active: true }];
    },
    async screenshot({ viewId }) {
      if (!viewId && viewId !== undefined) return { ok: false, error: 'unknown viewId' };
      return { ok: true, viewId: viewId || 'v1', dataUrl: 'data:image/png;base64,AAA', scale: 1 };
    },
    async action(params) {
      actions.push(params);
      if (params.action === 'boom') return { ok: false, error: 'unsupported action: boom' };
      return { ok: true };
    },
    async dom({ viewId }) {
      return { ok: true, viewId: viewId || 'v1', text: 'hello', elements: [] };
    },
  };
}

test('rejects requests without a bearer token', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port } = await server.start();
  try {
    const res = await request(port, { path: '/agent/browser/tabs' });
    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
  } finally {
    await server.stop();
  }
});

test('rejects requests with a wrong token', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port } = await server.start();
  try {
    const res = await request(port, { path: '/agent/browser/tabs', token: 'wrong-token' });
    assert.equal(res.status, 401);
  } finally {
    await server.stop();
  }
});

test('GET /agent/browser/tabs lists open tabs', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port, token } = await server.start();
  try {
    const res = await request(port, { path: '/agent/browser/tabs', token });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.tabs.length, 1);
    assert.equal(res.json.tabs[0].active, true);
  } finally {
    await server.stop();
  }
});

test('POST /agent/browser/screenshot returns a resized image payload', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port, token } = await server.start();
  try {
    const res = await request(port, { method: 'POST', path: '/agent/browser/screenshot', token, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.dataUrl.startsWith('data:image/png'));
  } finally {
    await server.stop();
  }
});

test('POST /agent/browser/action dispatches a single action', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port, token } = await server.start();
  try {
    const res = await request(port, {
      method: 'POST',
      path: '/agent/browser/action',
      token,
      body: { action: 'left_click', coordinate: [10, 20] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(remote.actions.length, 1);
    assert.deepEqual(remote.actions[0].coordinate, [10, 20]);
  } finally {
    await server.stop();
  }
});

test('POST /agent/browser/action without an action field is a 400', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port, token } = await server.start();
  try {
    const res = await request(port, { method: 'POST', path: '/agent/browser/action', token, body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  } finally {
    await server.stop();
  }
});

test('POST /agent/browser/action surfaces a remote failure as a 400', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port, token } = await server.start();
  try {
    const res = await request(port, { method: 'POST', path: '/agent/browser/action', token, body: { action: 'boom' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  } finally {
    await server.stop();
  }
});

test('GET /agent/browser/dom returns a text snapshot', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port, token } = await server.start();
  try {
    const res = await request(port, { path: '/agent/browser/dom', token });
    assert.equal(res.status, 200);
    assert.equal(res.json.text, 'hello');
  } finally {
    await server.stop();
  }
});

test('unknown route is a 404', async () => {
  const remote = makeFakeRemote();
  const server = createBrowserAgentServer(remote);
  const { port, token } = await server.start();
  try {
    const res = await request(port, { path: '/agent/browser/nope', token });
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
});

test('SM_DEV=1 writes to a dev-suffixed path, never the production browser-agent-api.json', async () => {
  const devPath = path.join(path.dirname(TOKEN_PATH), 'browser-agent-api.dev.json');
  const prevMtime = fs.existsSync(TOKEN_PATH) ? fs.statSync(TOKEN_PATH).mtimeMs : null;
  const prevEnv = process.env.SM_DEV;
  const remote = makeFakeRemote();
  let server;
  try {
    process.env.SM_DEV = '1';
    server = createBrowserAgentServer(remote);
    const { port, token } = await server.start();
    assert.equal(resolveTokenPath(), devPath);
    const parsed = JSON.parse(fs.readFileSync(devPath, 'utf8'));
    assert.equal(parsed.port, port);
    assert.equal(parsed.token, token);
    if (prevMtime !== null) {
      assert.equal(fs.statSync(TOKEN_PATH).mtimeMs, prevMtime);
    } else {
      assert.equal(fs.existsSync(TOKEN_PATH), false);
    }
  } finally {
    if (server) await server.stop();
    if (prevEnv === undefined) delete process.env.SM_DEV; else process.env.SM_DEV = prevEnv;
    fs.rmSync(devPath, { force: true });
  }
});

test('with neither SM_DEV nor SM_E2E set, writes to the original browser-agent-api.json path', async () => {
  const prevDev = process.env.SM_DEV;
  const prevE2e = process.env.SM_E2E;
  const remote = makeFakeRemote();
  let server;
  try {
    delete process.env.SM_DEV;
    delete process.env.SM_E2E;
    assert.equal(resolveTokenPath(), TOKEN_PATH);
    server = createBrowserAgentServer(remote);
    const { port, token } = await server.start();
    const parsed = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    assert.equal(parsed.port, port);
    assert.equal(parsed.token, token);
  } finally {
    if (server) await server.stop();
    if (prevDev === undefined) delete process.env.SM_DEV; else process.env.SM_DEV = prevDev;
    if (prevE2e === undefined) delete process.env.SM_E2E; else process.env.SM_E2E = prevE2e;
  }
});
