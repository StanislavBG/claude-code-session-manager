/**
 * scheduler-mcp-server-artifacts.test.cjs — artifact_publish / artifact_list MCP
 * tools: registered with their input schemas, descriptions composed from the
 * catalog, and forwarding to POST /admin/artifacts/publish and GET /admin/artifacts
 * with the calling session hints (SM_CHAT_SESSION_ID, SM_PROJECT_ROOT).
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/scheduler-mcp-server-artifacts.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../scheduler-mcp-server.cjs');
const { MCP_TOOL_CATALOG, composeDescription } = require('../../src/main/lib/mcpToolCatalog.cjs');

const ENV_KEYS = ['HOME', 'SM_PROJECT_ROOT', 'SM_CHAT_SESSION_ID'];
const savedEnv = {};
const tmpDirs = [];
const servers = [];

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (!(k in savedEnv)) continue;
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) await new Promise((r) => servers.pop().close(r));
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function setEnv(k, v) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

async function mkTmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-artifacts-'));
  tmpDirs.push(d);
  return d;
}

function startFakeAdminServer(token, body) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad token' }));
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

async function loadServer({ adminBody } = {}) {
  const homeDir = await mkTmp();
  setEnv('HOME', homeDir);
  let requests = null;
  if (adminBody) {
    const token = 'test-token';
    const fake = await startFakeAdminServer(token, adminBody);
    requests = fake.requests;
    const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
    await fsp.writeFile(tokenPath, JSON.stringify({ port: fake.server.address().port, token }), 'utf8');
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  return { mod: require(SERVER_PATH), requests };
}

const call = (handleCallTool, name, args) => handleCallTool({ params: { name, arguments: args } });

test('artifact_publish and artifact_list are registered with their input schemas', async () => {
  const { mod: { TOOLS } } = await loadServer();
  const publish = TOOLS.find((t) => t.name === 'artifact_publish');
  const list = TOOLS.find((t) => t.name === 'artifact_list');
  expect(publish).toBeTruthy();
  expect(list).toBeTruthy();
  expect(publish.inputSchema.type).toBe('object');
  expect(Object.keys(publish.inputSchema.properties).sort()).toEqual(['kind', 'path', 'title']);
  for (const k of ['path', 'title', 'kind']) expect(publish.inputSchema.properties[k].type).toBe('string');
  expect(publish.inputSchema.required).toEqual(['path']);
  expect(list.inputSchema.type).toBe('object');
  expect(Object.keys(list.inputSchema.properties)).toEqual(['cwd']);
  expect(list.inputSchema.properties.cwd.type).toBe('string');
  expect(list.inputSchema.required ?? []).toEqual([]);
  for (const t of [publish, list]) {
    const entry = MCP_TOOL_CATALOG.find((e) => e.name === t.name);
    expect(entry.group).toBe('artifacts');
    expect(t.description).toBe(composeDescription(entry));
    expect(entry.notes).toContain('File Explorer > Artifacts');
  }
  for (const s of ['every file a human should review', 'renders', 'audio takes', 'reports', 'contact sheets']) {
    expect(publish.description).toContain(s);
  }
});

test('artifact_publish forwards path/title/kind plus SM_CHAT_SESSION_ID and SM_PROJECT_ROOT', async () => {
  setEnv('SM_CHAT_SESSION_ID', 'chat-123');
  setEnv('SM_PROJECT_ROOT', '/home/u/Projects/demo');
  const reply = { ok: true, storedPath: '/home/u/Projects/demo/session-manager-operations/artifacts/x/a.png' };
  const { mod: { handleCallTool }, requests } = await loadServer({ adminBody: reply });
  const result = await call(handleCallTool, 'artifact_publish', { path: '/tmp/a.png', title: 'Hero', kind: 'image' });
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual(reply);
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/artifacts/publish');
  expect(requests[0].body).toEqual({
    path: '/tmp/a.png', title: 'Hero', kind: 'image',
    cwd: '/home/u/Projects/demo', originClaudeSessionId: 'chat-123',
  });
});

test('artifact_publish omits absent hints and optional args; requires path', async () => {
  setEnv('SM_CHAT_SESSION_ID', undefined);
  setEnv('SM_PROJECT_ROOT', undefined);
  const { mod: { handleCallTool }, requests } = await loadServer({ adminBody: { ok: true } });
  const bad = await call(handleCallTool, 'artifact_publish', { title: 'x' });
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain('path');
  expect(requests).toHaveLength(0);
  await call(handleCallTool, 'artifact_publish', { path: 'out/report.md' });
  expect(requests[0].body).toEqual({ path: 'out/report.md', cwd: process.cwd() });
});

test('artifact_list forwards GET /admin/artifacts with cwd and the session hints', async () => {
  setEnv('SM_CHAT_SESSION_ID', 'chat-9');
  setEnv('SM_PROJECT_ROOT', '/home/u/Projects/demo');
  const { mod: { handleCallTool }, requests } = await loadServer({ adminBody: { ok: true, artifacts: [] } });
  await call(handleCallTool, 'artifact_list', {});
  await call(handleCallTool, 'artifact_list', { cwd: '/home/u/Projects/other' });
  expect(requests.map((r) => r.method)).toEqual(['GET', 'GET']);
  const q0 = new URL(requests[0].url, 'http://x');
  expect(q0.pathname).toBe('/admin/artifacts');
  expect(Object.fromEntries(q0.searchParams)).toEqual({
    cwd: '/home/u/Projects/demo', originClaudeSessionId: 'chat-9',
  });
  expect(new URL(requests[1].url, 'http://x').searchParams.get('cwd')).toBe('/home/u/Projects/other');
});

test('artifact tools return the app-not-running error when the admin API is unreachable', async () => {
  const { mod: { handleCallTool, NOT_RUNNING_ERROR } } = await loadServer();
  for (const [name, args] of [['artifact_publish', { path: '/tmp/a.png' }], ['artifact_list', {}]]) {
    const r = await call(handleCallTool, name, args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(NOT_RUNNING_ERROR);
  }
});
