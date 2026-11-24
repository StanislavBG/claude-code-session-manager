/**
 * schedulerMcpServerPause.test.cjs — scheduler_pause / scheduler_resume send their
 * literal admin routes (POST /admin/scheduler/pause|resume) with the right body.
 * Same HOME-repointing pattern as schedulerMcpServerCustomerFeedback.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerPause.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');

const tmpDirs = [];
const servers = [];
let originalHome;

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
    originalHome = undefined;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) {
    const s = servers.pop();
    await new Promise((resolve) => s.close(resolve));
  }
  while (tmpDirs.length) {
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
  }
});

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
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

async function writeAdminConfig(homeDir, { port, token }) {
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port, token }), 'utf8');
}

function requireServerWithHome(homeDir) {
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  delete require.cache[require.resolve(SERVER_PATH)];
  return require(SERVER_PATH);
}

async function setup() {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-pause-'));
  tmpDirs.push(homeDir);
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });
  return { ...requireServerWithHome(homeDir), requests };
}

test('scheduler_pause sends POST /admin/scheduler/pause with origin, cwd and reason', async () => {
  const { handleCallTool, requests } = await setup();
  const res = await handleCallTool({ params: { name: 'scheduler_pause', arguments: { reason: 'r' } } });
  expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/scheduler/pause');
  expect(requests[0].body).toEqual({
    originClaudeSessionId: process.env.SM_CHAT_SESSION_ID ?? null,
    cwd: process.cwd(),
    reason: 'r',
  });
});

test('scheduler_resume sends POST /admin/scheduler/resume with an empty body', async () => {
  const { handleCallTool, requests } = await setup();
  const res = await handleCallTool({ params: { name: 'scheduler_resume', arguments: {} } });
  expect(JSON.parse(res.content[0].text)).toEqual({ ok: true });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/scheduler/resume');
  expect(requests[0].body).toEqual({});
});
