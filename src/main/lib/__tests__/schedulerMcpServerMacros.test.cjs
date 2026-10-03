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

afterEach(async () => {
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
