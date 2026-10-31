/**
 * schedulerMcpServerMacros.test.cjs — the macro_list/macro_save MCP tools
 * wrapping GET /admin/macros and POST /admin/macros/save.
 * Same HOME-repointing pattern as schedulerMcpServerProjectHome.test.cjs —
 * see that file's header for why.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerMacros.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { MCP_TOOL_CATALOG, composeDescription } = require('../mcpToolCatalog.cjs');

const LIST_TOOL_NAME = 'macro_list';
const SAVE_TOOL_NAME = 'macro_save';

const tmpDirs = [];
const servers = [];
let originalHome;
let originalProjectRoot;
const ENV_KEYS = ['SM_CHAT_SESSION_ID', 'SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MAY_QUEUE'];
const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
    originalHome = undefined;
  }
  if (originalProjectRoot !== undefined) {
    if (originalProjectRoot === null) delete process.env.SM_PROJECT_ROOT;
    else process.env.SM_PROJECT_ROOT = originalProjectRoot;
    originalProjectRoot = undefined;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) {
    const s = servers.pop();
    await new Promise((resolve) => s.close(resolve));
  }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-macros-'));
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
        requests.push({
          method: req.method,
          url: req.url,
          body: raw ? JSON.parse(raw) : undefined,
        });
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
  delete require.cache[require.resolve(SERVER_PATH)];
  const mod = require(SERVER_PATH);
  return mod;
}

async function writeAdminConfig(homeDir, { port, token }) {
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port, token }), 'utf8');
}

function callTool(handleCallTool, name, args) {
  return handleCallTool({ params: { name, arguments: args } });
}

test('macro_list and macro_save are listed in TOOLS', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  expect(TOOLS.find((t) => t.name === LIST_TOOL_NAME)).toBeTruthy();
  const saveTool = TOOLS.find((t) => t.name === SAVE_TOOL_NAME);
  expect(saveTool).toBeTruthy();
  expect(saveTool.inputSchema.required).toEqual(expect.arrayContaining(['label', 'agentName', 'tag', 'prompt']));
});

test('macro_list and macro_save descriptions equal the catalog-composed string', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  for (const name of [LIST_TOOL_NAME, SAVE_TOOL_NAME]) {
    const tool = TOOLS.find((t) => t.name === name);
    const entry = MCP_TOOL_CATALOG.find((e) => e.name === name);
    expect(entry).toBeTruthy();
    expect(tool.description).toBe(composeDescription(entry));
  }
});

test('macro_list dispatches GET /admin/macros?cwd=<encoded>', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, macros: [] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, LIST_TOOL_NAME, { cwd: '/home/bilko/Projects/session-manager' });
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  expect(requests[0].url).toBe(`/admin/macros?cwd=${encodeURIComponent('/home/bilko/Projects/session-manager')}`);
});

test('macro_list defaults cwd to SM_PROJECT_ROOT when omitted', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, macros: [] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  originalProjectRoot = process.env.SM_PROJECT_ROOT ?? null;
  process.env.SM_PROJECT_ROOT = '/home/bilko/Projects/session-manager';

  const { handleCallTool } = requireServerWithHome(homeDir);
  await callTool(handleCallTool, LIST_TOOL_NAME, {});
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(`/admin/macros?cwd=${encodeURIComponent(process.env.SM_PROJECT_ROOT)}`);
});

test('macro_save forwards the body to /admin/macros/save with the resolved cwd', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, macro: { id: 'publish-git-npm' } });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const args = {
    cwd: '/home/bilko/Projects/session-manager',
    label: 'Publish git + npm',
    agentName: 'builder',
    tag: 'feature',
    prompt: 'Run the full publish flow.',
  };
  const result = await callTool(handleCallTool, SAVE_TOOL_NAME, args);
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/macros/save');
  expect(requests[0].body).toEqual({
    cwd: '/home/bilko/Projects/session-manager',
    label: 'Publish git + npm',
    agentName: 'builder',
    tag: 'feature',
    prompt: 'Run the full publish flow.',
  });
});

test('macro_save forwards inputs verbatim in the POST body', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, macro: {} });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const inputs = [
    { name: 'stream', label: 'Stream', default: 'education-veggies', required: true, options: ['a', 'b'] },
  ];
  const result = await callTool(handleCallTool, SAVE_TOOL_NAME, {
    cwd: '/home/bilko/Projects/session-manager',
    label: 'Run stream',
    agentName: 'builder',
    tag: 'feature',
    prompt: 'Run {{stream}}.',
    inputs,
  });
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.inputs).toEqual(inputs);
});

test('macro_save without inputs sends a body with no inputs key', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, macro: {} });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  await callTool(handleCallTool, SAVE_TOOL_NAME, {
    cwd: '/home/bilko/Projects/session-manager',
    label: 'Plain',
    agentName: 'builder',
    tag: 'feature',
    prompt: 'No inputs.',
  });
  expect(requests).toHaveLength(1);
  expect(Object.prototype.hasOwnProperty.call(requests[0].body, 'inputs')).toBe(false);
});

test('macro_save defaults cwd to SM_PROJECT_ROOT when omitted', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, macro: {} });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  originalProjectRoot = process.env.SM_PROJECT_ROOT ?? null;
  process.env.SM_PROJECT_ROOT = '/home/bilko/Projects/session-manager';

  const { handleCallTool } = requireServerWithHome(homeDir);
  await callTool(handleCallTool, SAVE_TOOL_NAME, {
    label: 'Publish git + npm',
    agentName: 'builder',
    tag: 'feature',
    prompt: 'Run the full publish flow.',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].body.cwd).toBe(process.env.SM_PROJECT_ROOT);
});

test('macro_save returns an error result when a required field is missing or not a string', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  const base = { label: 'L', agentName: 'builder', tag: 'feature', prompt: 'P' };
  for (const field of ['label', 'agentName', 'tag', 'prompt']) {
    const args = { ...base, [field]: undefined };
    const result = await callTool(handleCallTool, SAVE_TOOL_NAME, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(field);
  }
  const resultBadType = await callTool(handleCallTool, SAVE_TOOL_NAME, { ...base, label: 42 });
  expect(resultBadType.isError).toBe(true);
});

function setDeleteEnv({ chat, slug, mayQueue }) {
  for (const [k, v] of [['SM_CHAT_SESSION_ID', chat], ['SM_SCHEDULER_JOB_SLUG', slug], ['SM_SCHEDULER_JOB_MAY_QUEUE', mayQueue]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function deleteHarness(body) {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, body);
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });
  originalProjectRoot = process.env.SM_PROJECT_ROOT ?? null;
  process.env.SM_PROJECT_ROOT = '/home/bilko/Projects/session-manager';
  const { handleCallTool, TOOLS } = requireServerWithHome(homeDir);
  return { handleCallTool, TOOLS, requests };
}

test('macro_delete is listed with only id, required, catalog description', async () => {
  const { TOOLS } = requireServerWithHome(await mkTmp());
  const tool = TOOLS.find((t) => t.name === 'macro_delete');
  expect(tool).toBeTruthy();
  expect(Object.keys(tool.inputSchema.properties)).toEqual(['id']);
  expect(tool.inputSchema.required).toEqual(['id']);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'macro_delete');
  expect(entry.group).toBe('macros');
  expect(tool.description).toBe(composeDescription(entry));
});

test('macro_delete posts exactly { cwd, id, originClaudeSessionId } and ignores a cwd argument', async () => {
  setDeleteEnv({ chat: 'chat-123' });
  const { handleCallTool, requests } = await deleteHarness({ ok: true, deleted: true, macro: { id: 'm1' } });
  const result = await callTool(handleCallTool, 'macro_delete', { id: 'm1', cwd: '/some/other/project' });
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, deleted: true, macro: { id: 'm1' } });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/macros/delete');
  expect(requests[0].body).toEqual({
    cwd: '/home/bilko/Projects/session-manager',
    id: 'm1',
    originClaudeSessionId: 'chat-123',
  });
});

test('macro_delete refuses a bad id without any HTTP request', async () => {
  setDeleteEnv({ chat: 'chat-123' });
  const { handleCallTool, requests } = await deleteHarness({ ok: true });
  for (const args of [{}, { id: '' }, { id: 7 }, { id: null }]) {
    const result = await callTool(handleCallTool, 'macro_delete', args);
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});

test('macro_delete refuses in a scheduled job, even one that may queue', async () => {
  const { handleCallTool, requests } = await deleteHarness({ ok: true });
  for (const mayQueue of [undefined, '1']) {
    setDeleteEnv({ chat: 'chat-123', slug: 'some-job', mayQueue });
    const result = await callTool(handleCallTool, 'macro_delete', { id: 'm1' });
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});

test('macro_delete refuses outside a Session Manager session', async () => {
  setDeleteEnv({});
  const { handleCallTool, requests } = await deleteHarness({ ok: true });
  const result = await callTool(handleCallTool, 'macro_delete', { id: 'm1' });
  expect(result.isError).toBe(true);
  expect(requests).toHaveLength(0);
});

test('macro_delete turns an admin { ok: false, error } into an error result', async () => {
  setDeleteEnv({ chat: 'chat-123' });
  const { handleCallTool } = await deleteHarness({ ok: false, error: 'macro not listed for this project' });
  const result = await callTool(handleCallTool, 'macro_delete', { id: 'm1' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('macro not listed for this project');
});
