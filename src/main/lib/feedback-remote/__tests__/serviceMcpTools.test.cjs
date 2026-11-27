/**
 * serviceMcpTools.test.cjs — the paired-service MCP tool definitions:
 * one entry per SERVICE_TOOL_NAMES, the four shared tools reuse the stdio
 * server's exact inputSchema objects and send the request its handlers send,
 * and the two service-only tools never appear in the stdio server.
 *
 * Run: timeout 120 npx vitest run src/main/lib/feedback-remote/__tests__/serviceMcpTools.test.cjs
 */
'use strict';

import { test, expect, afterEach, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  SERVICE_TOOLS, SERVICE_ONLY_TOOL_NAMES, EVENTS_READ_KINDS, PROJECT_CREATE_INPUT_SCHEMA,
} = require('../serviceMcpTools.cjs');
const { SERVICE_TOOL_NAMES } = require('../servicePairings.cjs');
const { MCP_TOOL_CATALOG, composeDescription } = require('../../mcpToolCatalog.cjs');

const SERVER_PATH = path.join(__dirname, '../../../../../scripts/scheduler-mcp-server.cjs');
const SHARED = ['feedback_list_projects', 'feedback_open_session', 'macro_list', 'epic_get'];
const byName = (name) => SERVICE_TOOLS.find((t) => t.name === name);

const ENV_KEYS = ['HOME', 'SM_CHAT_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'SM_PROJECT_ROOT'];
const savedEnv = {};
const tmpDirs = [];
const servers = [];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.SM_CHAT_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.SM_PROJECT_ROOT;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) {
    const s = servers.pop();
    await new Promise((resolve) => s.close(resolve));
  }
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function requireServer() {
  return require(SERVER_PATH);
}

/** Point HOME at a temp dir holding admin-api.json for a fake admin server; returns its recorded requests. */
async function fakeAdmin() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-service-tools-'));
  tmpDirs.push(home);
  const token = 'test-token';
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const tokenPath = path.join(home, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port: server.address().port, token }), 'utf8');
  process.env.HOME = home;
  delete require.cache[require.resolve(SERVER_PATH)];
  return requests;
}

/** Compare a recorded HTTP request with a toRequest() result (query compared as parsed params). */
function expectSameRequest(recorded, shaped) {
  expect(recorded.method).toBe(shaped.method);
  const url = new URL(recorded.url, 'http://x');
  expect(url.pathname).toBe(shaped.path);
  expect(Object.fromEntries(url.searchParams)).toEqual(shaped.query ?? {});
  expect(recorded.body).toEqual(shaped.body);
}

test('SERVICE_TOOLS has exactly one entry per SERVICE_TOOL_NAMES name, in order', () => {
  expect(SERVICE_TOOLS.map((t) => t.name)).toEqual([...SERVICE_TOOL_NAMES]);
  for (const tool of SERVICE_TOOLS) {
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.inputSchema.type).toBe('object');
    expect(typeof tool.toRequest).toBe('function');
  }
});

test('no inputSchema uses a top-level oneOf / anyOf / allOf', () => {
  for (const tool of SERVICE_TOOLS) {
    expect(tool.inputSchema).not.toHaveProperty('oneOf');
    expect(tool.inputSchema).not.toHaveProperty('anyOf');
    expect(tool.inputSchema).not.toHaveProperty('allOf');
  }
});

test('shared tools reuse the stdio server\'s exact inputSchema objects and catalog descriptions', () => {
  const { TOOLS } = requireServer();
  for (const name of SHARED) {
    const local = TOOLS.find((t) => t.name === name);
    expect(local, name).toBeTruthy();
    expect(byName(name).inputSchema).toBe(local.inputSchema);
    const entry = MCP_TOOL_CATALOG.find((e) => e.name === name);
    expect(byName(name).description).toBe(composeDescription(entry));
    expect(byName(name).description).toBe(local.description);
  }
});

test('service-only tools are absent from the stdio server and the catalog', () => {
  expect([...SERVICE_ONLY_TOOL_NAMES]).toEqual(['macro_run', 'events_read', 'project_create']);
  const { TOOLS } = requireServer();
  const localNames = TOOLS.map((t) => t.name);
  for (const name of SERVICE_ONLY_TOOL_NAMES) {
    expect(localNames).not.toContain(name);
    expect(MCP_TOOL_CATALOG.find((e) => e.name === name)).toBeUndefined();
  }
});

test('project_create: inline description, schema shape, POST /admin/projects/create', () => {
  const tool = byName('project_create');
  expect(tool.inputSchema).toBe(PROJECT_CREATE_INPUT_SCHEMA);
  expect(tool.description).toMatch(/projects folder the owner approved/);
  expect(MCP_TOOL_CATALOG.find((e) => e.name === 'project_create')).toBeUndefined();
  const s = PROJECT_CREATE_INPUT_SCHEMA;
  expect(s.type).toBe('object');
  expect(s.required).toEqual(['name', 'externalRef']);
  expect(Object.keys(s.properties).sort()).toEqual(['externalRef', 'github', 'name', 'parentDir']);
  expect(s.properties.github.type).toEqual(['boolean', 'object']);
  expect(s.properties.github.description).toMatch(/true/);
  expect(s.properties.github.description).toMatch(/false/);
  expect(s.properties.github.description).toMatch(/\{ private: true, owner\? \}/);
  expect(tool.toRequest({ name: 'foo', externalRef: 'k-1', github: true }).body.github).toBe(true);
  expect(s.properties.github.properties.private.type).toBe('boolean');
  expect(s.properties.github.properties.owner.type).toBe('string');
  expect(s.properties.parentDir.type).toBe('string');
  expect(s).not.toHaveProperty('oneOf');
  expect(s).not.toHaveProperty('anyOf');
  expect(tool.toRequest({ name: 'foo', externalRef: 'k-1' })).toEqual({
    method: 'POST', path: '/admin/projects/create', body: { name: 'foo', externalRef: 'k-1' },
  });
  expect(tool.toRequest({ name: 'foo', externalRef: 'k-1', github: { private: true }, parentDir: '/p', junk: 1 })).toEqual({
    method: 'POST', path: '/admin/projects/create',
    body: { name: 'foo', externalRef: 'k-1', github: { private: true }, parentDir: '/p' },
  });
});

test('feedback_list_projects toRequest matches the stdio handler', async () => {
  const requests = await fakeAdmin();
  const { handleCallTool } = requireServer();
  await handleCallTool({ params: { name: 'feedback_list_projects', arguments: {} } });
  const shaped = byName('feedback_list_projects').toRequest({});
  expect(shaped).toEqual({ method: 'GET', path: '/admin/feedback/targets', query: {} });
  expect(requests).toHaveLength(1);
  expectSameRequest(requests[0], shaped);
});

test('feedback_list_projects forwards cwd / limit / offset identically on both surfaces', async () => {
  const requests = await fakeAdmin();
  const { handleCallTool } = requireServer();
  const args = { cwd: '/abs/receiver', limit: 50, offset: 100 };
  await handleCallTool({ params: { name: 'feedback_list_projects', arguments: args } });
  const shaped = byName('feedback_list_projects').toRequest(args);
  expect(shaped.query).toEqual({ cwd: '/abs/receiver', limit: '50', offset: '100' });
  expect(requests).toHaveLength(1);
  expectSameRequest(requests[0], shaped);
});

test('feedback_open_session toRequest matches the stdio handler and drops caller-supplied identity', async () => {
  const args = {
    toCwd: '/abs/receiver', fromCwd: '/abs/sender', title: 'A finding', motivation: 'why',
    acceptanceCriteria: ['done'], body: 'detail', tag: 'bug', externalRef: 'kiln:1',
  };
  const requests = await fakeAdmin();
  const { handleCallTool } = requireServer();
  await handleCallTool({ params: { name: 'feedback_open_session', arguments: args } });
  const shaped = byName('feedback_open_session').toRequest(args);
  expect(shaped).toEqual({ method: 'POST', path: '/admin/feedback/open-session', body: args });
  expect(requests).toHaveLength(1);
  expectSameRequest(requests[0], shaped);

  const forged = byName('feedback_open_session').toRequest({ ...args, originClaudeSessionId: 'x', originProjectRoot: '/y' });
  expect(forged.body).toEqual(args);
});

test('macro_list toRequest matches the stdio handler', async () => {
  const requests = await fakeAdmin();
  const { handleCallTool } = requireServer();
  const args = { cwd: '/home/u/Projects/a b' };
  await handleCallTool({ params: { name: 'macro_list', arguments: args } });
  const shaped = byName('macro_list').toRequest(args);
  expect(shaped).toEqual({ method: 'GET', path: '/admin/macros', query: { cwd: '/home/u/Projects/a b' } });
  expect(requests).toHaveLength(1);
  expectSameRequest(requests[0], shaped);
});

test('epic_get toRequest matches the stdio handler for id, externalRef and receipt', async () => {
  const cases = [
    [{ cwd: '/abs/p', id: 'e1' }, { cwd: '/abs/p', id: 'e1' }],
    [{ cwd: '/abs/p', externalRef: 'kiln:7', receipt: true }, { cwd: '/abs/p', externalRef: 'kiln:7', receipt: '1' }],
  ];
  for (const [args, query] of cases) {
    const requests = await fakeAdmin();
    const { handleCallTool } = requireServer();
    await handleCallTool({ params: { name: 'epic_get', arguments: args } });
    const shaped = byName('epic_get').toRequest(args);
    expect(shaped).toEqual({ method: 'GET', path: '/admin/epic', query });
    expect(requests).toHaveLength(1);
    expectSameRequest(requests[0], shaped);
  }
});

test('macro_run maps { cwd, id, inputs?, effort?, externalRef? } to POST /admin/macros/run', () => {
  const tool = byName('macro_run');
  expect(tool.inputSchema.required).toEqual(['cwd', 'id']);
  expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['cwd', 'effort', 'externalRef', 'id', 'inputs']);
  expect(tool.toRequest({ cwd: '/abs/p', id: 'm1' })).toEqual({
    method: 'POST', path: '/admin/macros/run', body: { cwd: '/abs/p', id: 'm1' },
  });
  expect(tool.toRequest({ cwd: '/abs/p', id: 'm1', inputs: { topic: 'x' }, effort: 'high', externalRef: '2026-11-23', extra: 1 })).toEqual({
    method: 'POST', path: '/admin/macros/run',
    body: { cwd: '/abs/p', id: 'm1', inputs: { topic: 'x' }, effort: 'high', externalRef: '2026-11-23' },
  });
});

test('events_read maps { after?, kinds?, limit? } to GET /admin/events with kinds limited to two', () => {
  const tool = byName('events_read');
  expect([...EVENTS_READ_KINDS]).toEqual(['epic_state_changed', 'epic_cross_project_reply']);
  expect(tool.inputSchema.properties.kinds.items.enum).toEqual(['epic_state_changed', 'epic_cross_project_reply']);
  expect(tool.inputSchema.required).toBeUndefined();
  expect(tool.toRequest({})).toEqual({ method: 'GET', path: '/admin/events', query: {} });
  expect(tool.toRequest({ after: 'start', kinds: ['epic_state_changed', 'epic_cross_project_reply'], limit: 50 })).toEqual({
    method: 'GET', path: '/admin/events',
    query: { after: 'start', kinds: 'epic_state_changed,epic_cross_project_reply', limit: '50' },
  });
  expect(() => tool.toRequest({ kinds: ['job_transition'] })).toThrow(/not allowed/);
});

test('lib-layout lists serviceMcpTools under feedback-remote', () => {
  const layout = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '../../../../../scripts/lib-layout.json'), 'utf8'));
  expect(layout.serviceMcpTools).toBe('feedback-remote');
});
