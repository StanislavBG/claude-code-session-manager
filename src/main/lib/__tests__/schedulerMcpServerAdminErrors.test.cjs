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

function jsonServer(status, body) {
  return http.createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
}

test('legacy 404 {ok:false,error:"not found"} -> skew text naming the route, both versions', async () => {
  const port = await listen(jsonServer(404, { ok: false, error: 'not found' }));
  const mod = await setup(port);
  const result = await call(mod);
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  expect(text).toMatch(/GET \/admin\/[^\s?]+/);
  expect(text).not.toContain('?');
  expect(text).toContain('version not reported');
  expect(text).toContain(`v${require('../../../../package.json').version}`);
  // This test tree is a git checkout (or worktree), so the checkout wording applies.
  expect(text).toContain('runs from a source checkout');
  expect(text).not.toContain('Restart Session Manager');
});

test('404 with unknownRoute + appVersion -> skew text naming the app version', async () => {
  const port = await listen(jsonServer(404, { ok: false, error: 'not found', unknownRoute: 'GET /admin/x', appVersion: '0.1.0' }));
  const mod = await setup(port);
  const result = await call(mod);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('v0.1.0');
  expect(result.content[0].text).toContain('runs from a source checkout');
});

const resetJob = (mod) => mod.handleCallTool({ params: { name: 'scheduler_reset_job', arguments: { slug: 'nope' } } });

test('HTTP 200 not-found body (reset-job unknown slug) passes through unchanged', async () => {
  const port = await listen(jsonServer(200, { ok: false, error: 'not found' }));
  const mod = await setup(port);
  const result = await resetJob(mod);
  expect(result.isError).toBeUndefined();
  const text = result.content[0].text;
  expect(text).toBe(JSON.stringify({ ok: false, error: 'not found' }));
  expect(text).toContain('"error":"not found"');
  expect(text).not.toContain('has no route');
});

test('HTTP 404 with other error text passes through unchanged', async () => {
  const port = await listen(jsonServer(404, { ok: false, error: 'invalid slug' }));
  const mod = await setup(port);
  const text = (await resetJob(mod)).content[0].text;
  expect(text).toBe(JSON.stringify({ ok: false, error: 'invalid slug' }));
  expect(text).not.toContain('has no route');
});

// ---- unknownRouteMessage: the advice is chosen from evidence, not assumed ----

function pureMod() {
  delete require.cache[require.resolve(SERVER_PATH)];
  return require(SERVER_PATH);
}

test('from a checkout: says the version does not identify the code; no plain restart fix', () => {
  const { unknownRouteMessage } = pureMod();
  const msg = unknownRouteMessage({
    method: 'GET', pathname: '/admin/epic', appVersion: '0.137.0', serverVersion: '0.138.0', fromCheckout: true,
  });
  expect(msg).toContain('GET /admin/epic');
  expect(msg).toContain('v0.137.0');
  expect(msg).toContain('v0.138.0');
  expect(msg).toContain('runs from a source checkout');
  expect(msg).toContain('does not say which code it has');
  expect(msg).toContain('may not be in any published release yet');
  expect(msg).toContain('only once a release containing this route is installed');
  expect(msg).not.toContain('Restart Session Manager');
  expect(msg).not.toContain('is older than');
});

test('not from a checkout, app 0.9.0 < server 0.10.0 (numeric compare): older app, restart advice', () => {
  const { unknownRouteMessage } = pureMod();
  const msg = unknownRouteMessage({
    method: 'POST', pathname: '/admin/x', appVersion: '0.9.0', serverVersion: '0.10.0', fromCheckout: false,
  });
  expect(msg).toContain('POST /admin/x');
  expect(msg).toContain('v0.9.0');
  expect(msg).toContain('v0.10.0');
  expect(msg).toContain('is older than this MCP server');
  expect(msg).toContain("Restart Session Manager (Command Palette: 'Reboot app (drain first)')");
});

test('not from a checkout, app reported no version: older app, restart advice', () => {
  const { unknownRouteMessage } = pureMod();
  const msg = unknownRouteMessage({
    method: 'GET', pathname: '/admin/x', appVersion: null, serverVersion: '0.10.0', fromCheckout: false,
  });
  expect(msg).toContain('version not reported');
  expect(msg).toContain('Reboot app (drain first)');
});

test('not from a checkout, equal versions: restart alone will not help', () => {
  const { unknownRouteMessage } = pureMod();
  const msg = unknownRouteMessage({
    method: 'GET', pathname: '/admin/x', appVersion: '0.138.0', serverVersion: '0.138.0', fromCheckout: false,
  });
  expect(msg).toContain('v0.138.0');
  expect(msg).toContain('A restart alone will not help');
  expect(msg).toContain('must be updated to a build that has this route');
  expect(msg).not.toContain('Restart Session Manager');
  expect(msg).not.toContain('is older than');
});

test('compareVersions compares dotted numbers and ignores a pre-release suffix', () => {
  const { compareVersions } = pureMod();
  expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
  expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0);
  expect(compareVersions('1.2', '1.2.0')).toBe(0);
});
