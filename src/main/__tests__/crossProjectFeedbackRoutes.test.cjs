/**
 * crossProjectFeedbackRoutes.test.cjs — the HTTP hop for the project-to-project
 * conduit (lib/crossProjectFeedback.cjs's registerAdminRoute).
 *
 * Why this is its own file. crossProjectFeedback.test.cjs drives
 * openFeedbackSession() directly, and the MCP tool definitions live in
 * scripts/scheduler-mcp-server.cjs — so the ROUTE REGISTRATION between them was
 * the one layer nothing exercised. That layer has a real, silent failure mode:
 * a route registered under a path the MCP client doesn't call (or not
 * registered at all) surfaces only as `{"ok":false,"error":"not found"}` from a
 * tool that otherwise looks perfectly wired. Confirmed live 2026-08-08 against
 * a running app whose process predated the route being added.
 *
 * These tests boot the real transport (localAdminHttp.cjs) on a throwaway port
 * and speak real HTTP to it, so the method+path pair is asserted end to end
 * rather than assumed.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/crossProjectFeedbackRoutes.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { createAdminHttp, TOKEN_PATH } = require('../lib/localAdminHttp.cjs');
const crossProjectFeedback = require('../lib/crossProjectFeedback.cjs');
const { readActiveIndex } = require('../lib/epicMint.cjs');

// Never let start() overwrite the RUNNING app's admin-api.json — that orphans
// scheduler-mcp-server.cjs until an app restart (the incident documented in
// localAdminHttp.cjs's resolveTokenPath).
const TEST_TOKEN_PATH = path.join(path.dirname(TOKEN_PATH), `admin-api.xproj-test-${process.pid}.json`);
process.env.SM_ADMIN_TOKEN_PATH = TEST_TOKEN_PATH;

let adminHttp;
let port;
let token;

beforeAll(async () => {
  adminHttp = createAdminHttp();
  crossProjectFeedback.registerAdminRoute(adminHttp);
  ({ port, token } = await adminHttp.start());
});

afterAll(async () => {
  if (adminHttp) await adminHttp.stop();
  fs.rmSync(TEST_TOKEN_PATH, { force: true });
});

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkProject({ managed = true } = {}) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-xproj-route-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  if (managed) fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  // Project-overlay fixture for the DEFAULT_FEEDBACK_AGENT ('architect') —
  // ensureEpic's write-time persona-existence check (epicMint.cjs) now
  // requires a real persona file to mint against; this keeps these tests
  // hermetic instead of depending on the host's ~/.claude/agents/.
  const agentsDir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'architect.md'), '---\nname: architect\n---\nFixture persona for tests.\n');
  return fs.realpathSync(cwd);
}

function request({ method = 'GET', path: reqPath, body, auth = true }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// The exact method+path pairs scripts/scheduler-mcp-server.cjs calls.
// If either of these two tests fails, the MCP tool is dead in the water and
// reports only "not found".
// ---------------------------------------------------------------------------

test('GET /admin/feedback/targets is registered and answers', async () => {
  // Scanned against an EMPTY throwaway root, never the developer's real
  // ~/.claude/projects/ — the transcripts tests create and delete folders
  // there in their own afterEach, and scanning it made this test race their
  // teardown (green alone, intermittently red under the full suite).
  const emptyRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-xproj-scan-'));
  tmpDirs.push(emptyRoot);
  const res = await request({
    method: 'GET',
    path: `/admin/feedback/targets?projectsDir=${encodeURIComponent(emptyRoot)}`,
  });
  expect(res.status).toBe(200);
  expect(res.json.ok).toBe(true);
  expect(res.json.projects).toEqual([]);
});

test('POST /admin/feedback/open-session is registered and delivers', async () => {
  const to = await mkProject();
  const from = await mkProject();
  const res = await request({
    method: 'POST',
    path: '/admin/feedback/open-session',
    body: { toCwd: to, fromCwd: from, title: 'Route smoke', body: 'Delivered over real HTTP.' },
  });
  expect(res.status).toBe(200);
  expect(res.json.ok).toBe(true);
  expect(res.json.status).toBe('proposed');

  // The write really landed in the receiving project, not just in the response.
  const epic = readActiveIndex(to).sessions[res.json.epicId];
  expect(epic.status).toBe('proposed');
  expect(epic.source.producer).toBe('cross-project-feedback');
});

test('a refusal comes back as a 400 with the reason, not a 500 or a silent 200', async () => {
  const p = await mkProject();
  const res = await request({
    method: 'POST',
    path: '/admin/feedback/open-session',
    body: { toCwd: p, fromCwd: p, title: 'Same project', body: 'Should be refused.' },
  });
  expect(res.status).toBe(400);
  expect(res.json.ok).toBe(false);
  expect(res.json.error).toMatch(/\/develop/);
});

test('a malformed JSON body is a 400, never an unhandled throw', async () => {
  const res = await request({ method: 'POST', path: '/admin/feedback/open-session', body: '{not json' });
  expect(res.status).toBe(400);
  expect(res.json.error).toMatch(/invalid JSON body/);
});

test('both routes are behind the transport\'s bearer auth', async () => {
  expect((await request({ method: 'GET', path: '/admin/feedback/targets', auth: false })).status).toBe(401);
  expect((await request({ method: 'POST', path: '/admin/feedback/open-session', body: {}, auth: false })).status).toBe(401);
});
