/**
 * schedulerMcpServerFeedback.test.cjs — feedback_open_session forwards the
 * caller's session identity from SM_CHAT_SESSION_ID only.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerFeedback.test.cjs
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
let originalSession;

afterEach(async () => {
  if (originalHome !== undefined) { process.env.HOME = originalHome; originalHome = undefined; }
  if (originalSession !== undefined) {
    if (originalSession === null) delete process.env.SM_CHAT_SESSION_ID;
    else process.env.SM_CHAT_SESSION_ID = originalSession;
    originalSession = undefined;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) await new Promise((r) => servers.pop().close(r));
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function startFakeAdminServer(token, body) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

async function setup(body, sessionId) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-fb-'));
  tmpDirs.push(homeDir);
  const { server, requests } = await startFakeAdminServer('t', body);
  servers.push(server);
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port: server.address().port, token: 't' }), 'utf8');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalSession = process.env.SM_CHAT_SESSION_ID === undefined ? null : process.env.SM_CHAT_SESSION_ID;
  if (sessionId === undefined) delete process.env.SM_CHAT_SESSION_ID;
  else process.env.SM_CHAT_SESSION_ID = sessionId;
  delete require.cache[require.resolve(SERVER_PATH)];
  return { ...require(SERVER_PATH), requests };
}

const BASE = { toCwd: '/tmp/a', fromCwd: '/tmp/b', title: 't', body: 'b' };
const call = (h, args) => h({ params: { name: 'feedback_open_session', arguments: args } });

test('forwards SM_CHAT_SESSION_ID even when fromEpicId is passed', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, status: 'proposed' }, 'sess-123');
  await call(handleCallTool, { ...BASE, fromEpicId: 'epic-1' });
  expect(requests[0].body.originClaudeSessionId).toBe('sess-123');
  expect(requests[0].body.fromEpicId).toBe('epic-1');
});

test('drops a caller-supplied originClaudeSessionId when the env var is unset', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, status: 'proposed' }, undefined);
  await call(handleCallTool, { ...BASE, originClaudeSessionId: 'forged' });
  expect(requests[0].body).not.toHaveProperty('originClaudeSessionId');
});

test('env var overrides a caller-supplied originClaudeSessionId', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, status: 'proposed' }, 'real');
  await call(handleCallTool, { ...BASE, originClaudeSessionId: 'forged' });
  expect(requests[0].body.originClaudeSessionId).toBe('real');
});

test('not-granted reason is appended without args.autoStart', async () => {
  const { handleCallTool } = await setup({ ok: true, status: 'proposed', autoStart: { granted: false, reason: 'nope' } }, 'real');
  const r = await call(handleCallTool, BASE);
  expect(r.content[0].text).toContain('not granted: nope');
});
