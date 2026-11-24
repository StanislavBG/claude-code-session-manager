/**
 * schedulerMcpServerTasks.test.cjs — the read-only task_list/task_get MCP
 * tools wrapping GET /admin/tasks and GET /admin/task.
 * Same HOME-repointing pattern as schedulerMcpServerMacros.test.cjs —
 * see schedulerMcpServerProjectHome.test.cjs's header for why.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerTasks.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { MCP_TOOL_CATALOG, composeDescription } = require('../mcpToolCatalog.cjs');

const CWD = '/home/bilko/Projects/my project&x=1';
const tmpDirs = [];
const servers = [];
let originalHome;
const savedScope = process.env.SM_SCHEDULER_JOB_MCP_TOOLS;

afterEach(async () => {
  if (savedScope === undefined) delete process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  else process.env.SM_SCHEDULER_JOB_MCP_TOOLS = savedScope;
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

async function mkTmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-tasks-'));
  tmpDirs.push(d);
  return d;
}

function startFakeAdminServer(token, body) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad token' }));
          return;
        }
        requests.push({ method: req.method, url: req.url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

function requireServerWithHome(homeDir) {
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  delete process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  delete require.cache[require.resolve(SERVER_PATH)];
  return require(SERVER_PATH);
}

async function harness(body) {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, body);
  servers.push(server);
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port: server.address().port, token }), 'utf8');
  const mod = requireServerWithHome(homeDir);
  return { ...mod, requests };
}

function callTool(handleCallTool, name, args) {
  return handleCallTool({ params: { name, arguments: args } });
}

test('task_list and task_get are listed with their required args and catalog descriptions', async () => {
  const { TOOLS } = requireServerWithHome(await mkTmp());
  const list = TOOLS.find((t) => t.name === 'task_list');
  expect(list.inputSchema.required).toEqual(['cwd']);
  expect(Object.keys(list.inputSchema.properties).sort()).toEqual(
    ['agent', 'cwd', 'limit', 'offset', 'pipeline', 'runId', 'since', 'source', 'status', 'step', 'until'],
  );
  const get = TOOLS.find((t) => t.name === 'task_get');
  expect(get.inputSchema.required).toEqual(['cwd', 'id']);
  expect(Object.keys(get.inputSchema.properties).sort()).toEqual(['after', 'cwd', 'id']);
  expect(get.inputSchema.properties.after).toMatchObject({ type: 'integer', minimum: 0 });
  expect(MCP_TOOL_CATALOG.find((e) => e.name === 'task_get').whenToUse).toContain('`after`');
  for (const tool of [list, get]) {
    const entry = MCP_TOOL_CATALOG.find((e) => e.name === tool.name);
    expect(entry.group).toBe('tasks');
    expect(entry.purpose).toMatch(/^Read-only/);
    expect(entry.whenNotToUse).toContain('read-only');
    expect(tool.description).toBe(composeDescription(entry));
  }
});

test('task_list GETs /admin/tasks with every filter URL-encoded and returns the route JSON', async () => {
  const body = { ok: true, tasks: [{ taskId: 't1' }], total: 1, hasMore: false };
  const { handleCallTool, requests } = await harness(body);
  const args = {
    cwd: CWD,
    since: '2026-11-01T00:00:00.000Z',
    until: '2026-11-22T23:59:59.000Z',
    pipeline: 'burrow blog',
    runId: 'run/7',
    step: 'draft&edit',
    agent: 'dev-lead',
    status: 'error',
    source: 'direct',
    limit: 20,
    offset: 40,
  };
  const result = await callTool(handleCallTool, 'task_list', args);
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual(body);
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  const url = new URL(requests[0].url, 'http://x');
  expect(url.pathname).toBe('/admin/tasks');
  expect(Object.fromEntries(url.searchParams)).toEqual({ ...args, limit: '20', offset: '40' });
  expect(requests[0].url).toContain(`cwd=${encodeURIComponent(CWD).replace(/%20/g, '+')}`);
  expect(requests[0].url).not.toContain('&x=1');
});

test('task_list with only cwd sends only cwd and flags a partial page', async () => {
  const { handleCallTool, requests } = await harness({ ok: true, tasks: [{}], total: 3, hasMore: true });
  const result = await callTool(handleCallTool, 'task_list', { cwd: '/p' });
  expect(requests[0].url).toBe(`/admin/tasks?cwd=${encodeURIComponent('/p')}`);
  const out = JSON.parse(result.content[0].text);
  expect(out.note).toContain('partial list');
});

test('task_get GETs /admin/task?cwd=&id= URL-encoded and returns the route JSON', async () => {
  const body = { ok: true, task: { taskId: 'a b&c', prompt: 'hi', output: 'yo' } };
  const { handleCallTool, requests } = await harness(body);
  const result = await callTool(handleCallTool, 'task_get', { cwd: CWD, id: 'a b&c' });
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual(body);
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  const url = new URL(requests[0].url, 'http://x');
  expect(url.pathname).toBe('/admin/task');
  expect(Object.fromEntries(url.searchParams)).toEqual({ cwd: CWD, id: 'a b&c' });
});

test('task_get forwards after as the after query parameter; omitted → absent; invalid → refused', async () => {
  const { handleCallTool, requests } = await harness({ ok: true, task: {} });
  await callTool(handleCallTool, 'task_get', { cwd: '/p', id: 't1', after: 1234 });
  expect(Object.fromEntries(new URL(requests[0].url, 'http://x').searchParams)).toEqual({ cwd: '/p', id: 't1', after: '1234' });
  await callTool(handleCallTool, 'task_get', { cwd: '/p', id: 't1', after: 0 });
  expect(new URL(requests[1].url, 'http://x').searchParams.get('after')).toBe('0');
  await callTool(handleCallTool, 'task_get', { cwd: '/p', id: 't1' });
  expect(new URL(requests[2].url, 'http://x').searchParams.has('after')).toBe(false);
  for (const after of [-1, 1.5, '12']) {
    expect((await callTool(handleCallTool, 'task_get', { cwd: '/p', id: 't1', after })).isError).toBe(true);
  }
  expect(requests).toHaveLength(3);
});

test('task_get without an id is refused before any admin call', async () => {
  const { handleCallTool, requests } = await harness({ ok: true });
  for (const args of [{ cwd: '/p' }, { cwd: '/p', id: '' }, { cwd: '/p', id: 7 }]) {
    const result = await callTool(handleCallTool, 'task_get', args);
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});

test('task_get passes an admin { ok: false } answer through as its JSON, like agent_list', async () => {
  const body = { ok: false, error: 'unknown_task', id: 'nope' };
  const { handleCallTool } = await harness(body);
  const result = await callTool(handleCallTool, 'task_get', { cwd: '/p', id: 'nope' });
  expect(JSON.parse(result.content[0].text)).toEqual(body);
});
