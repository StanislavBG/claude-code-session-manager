/**
 * schedulerMcpServerAdminErrors.test.cjs — adminRequest distinguishes "app not
 * running" from "app did not answer" and from a non-JSON reply.
 * Same HOME-repointing harness as schedulerMcpServerCustomerFeedback.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerAdminErrors.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const TOOL = 'customer_feedback_list';

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
    await new Promise((resolve) => {
      s.close(resolve);
      if (s.closeAllConnections) s.closeAllConnections();
    });
  }
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function setup(port) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-adminerr-'));
  tmpDirs.push(homeDir);
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port, token: 't' }), 'utf8');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  delete require.cache[require.resolve(SERVER_PATH)];
  return require(SERVER_PATH);
}

function listen(server) {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const call = (mod) => mod.handleCallTool({ params: { name: TOOL, arguments: {} } });

test('closed port -> NOT_RUNNING text', async () => {
  const probe = net.createServer();
  const port = await new Promise((r) => probe.listen(0, '127.0.0.1', () => r(probe.address().port)));
  await new Promise((r) => probe.close(r));
  const mod = await setup(port);
  const result = await call(mod);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('session-manager app is not running');
});

test('socket destroyed mid-request -> BUSY text, not NOT_RUNNING', async () => {
  const port = await listen(net.createServer((sock) => sock.destroy()));
  const mod = await setup(port);
  const text = (await call(mod)).content[0].text;
  expect(text).toContain('session-manager admin API did not answer (');
  expect(text).toContain('the app is running but busy; the request may still be applied.');
  expect(text).toContain('scheduler_list_prds');
  expect(text).toContain('same slug');
  expect(text).not.toContain('is not running');
});

test('500 with non-JSON body -> error naming 500', async () => {
  const port = await listen(http.createServer((req, res) => {
    req.resume();
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  }));
  const mod = await setup(port);
  const result = await call(mod);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('500');
  expect(result.content[0].text).not.toContain('is not running');
});
