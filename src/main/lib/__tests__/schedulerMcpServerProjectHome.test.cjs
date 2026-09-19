/**
 * schedulerMcpServerProjectHome.test.cjs — the single project_home_write MCP
 * tool that wraps POST /admin/project-home/write.
 * Covers: presence in TOOLS, catalog-composed descriptions, correct
 * route/payload dispatch via a stubbed admin HTTP server, cwd defaulting to
 * SM_PROJECT_ROOT/process.cwd() when omitted, and the app-not-running failure
 * shape.
 *
 * Same HOME-repointing pattern as schedulerMcpServerHelp.test.cjs — see that
 * file's header for why.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerProjectHome.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { MCP_TOOL_CATALOG, composeDescription } = require('../mcpToolCatalog.cjs');

const TOOL_NAME = 'project_home_write';
const OLD_TOOL_NAMES = [
  'project_home_get_contract',
  'project_home_validate_summary',
  'project_home_render',
  'project_home_status',
];

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
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-project-home-'));
  tmpDirs.push(d);
  return d;
}

/** Starts a fake admin HTTP server that records every request and answers with `body`. */
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
  // HOME stays redirected until afterEach: admin-token path resolves lazily.
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

test('project_home_write is the only project_home_* tool, with html required and cwd optional', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  expect(TOOLS.filter((t) => t.name.startsWith('project_home_')).map((t) => t.name)).toEqual([TOOL_NAME]);
  for (const old of OLD_TOOL_NAMES) expect(TOOLS.find((t) => t.name === old)).toBeUndefined();
  const tool = TOOLS.find((t) => t.name === TOOL_NAME);
  expect(tool.inputSchema.type).toBe('object');
  expect(tool.inputSchema.properties.cwd).toBeTruthy();
  expect(tool.inputSchema.properties.html).toBeTruthy();
  expect(tool.inputSchema.required).toEqual(['html']);
});

test('project_home_write description equals the catalog-composed string; old entries are gone', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  const tool = TOOLS.find((t) => t.name === TOOL_NAME);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === TOOL_NAME);
  expect(entry).toBeTruthy();
  expect(entry.group).toBe('project-home');
  expect(tool.description).toBe(composeDescription(entry));
  for (const old of OLD_TOOL_NAMES) expect(MCP_TOOL_CATALOG.find((e) => e.name === old)).toBeUndefined();
});

test('project_home_write dispatches POST /admin/project-home/write with cwd+html', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, path: '/abs/home.html', bytes: 12 });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const html = '<!DOCTYPE html><html></html>';
  const result = await callTool(handleCallTool, TOOL_NAME, { cwd: '/home/bilko/Projects/session-manager', html });
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/project-home/write');
  expect(requests[0].body).toEqual({ cwd: '/home/bilko/Projects/session-manager', html });
});

test('project_home_write requires a non-empty html', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  for (const args of [{ cwd: '/x' }, { cwd: '/x', html: '' }]) {
    const result = await callTool(handleCallTool, TOOL_NAME, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('html');
  }
});

test('project_home_write defaults cwd to SM_PROJECT_ROOT when omitted', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  originalProjectRoot = process.env.SM_PROJECT_ROOT ?? null;
  process.env.SM_PROJECT_ROOT = '/home/bilko/Projects/session-manager/session-manager-operations/scheduler/epics/some-epic/worktree';

  const { handleCallTool } = requireServerWithHome(homeDir);
  await callTool(handleCallTool, TOOL_NAME, { html: '<p>x</p>' });
  expect(requests).toHaveLength(1);
  expect(requests[0].body.cwd).toBe(process.env.SM_PROJECT_ROOT);
});

test('project_home_write returns the app-not-running error when the admin API is unreachable', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool, NOT_RUNNING_ERROR } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, TOOL_NAME, { html: '<p>x</p>' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe(NOT_RUNNING_ERROR);
});
