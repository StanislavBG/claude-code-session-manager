/**
 * schedulerMcpServerHelp.test.cjs — session_manager_help argument handling
 * (none/tool/topic/unknown/both) and the pointer-suffix contract every
 * isError return in scheduler-mcp-server.cjs now carries. Also covers the
 * "app not running" degradation: the static catalog must still answer even
 * when the admin API is unreachable — only the readiness section may report
 * unavailable.
 *
 * TOKEN_PATH (scripts/scheduler-mcp-server.cjs) is computed once, at
 * require-time, from os.homedir(). Since os.homedir() reads process.env.HOME
 * on POSIX, each test temporarily repoints HOME at a fresh tmp dir, clears
 * the require cache, and re-requires the module so TOKEN_PATH resolves under
 * that tmp dir — never touching the real ~/.claude/session-manager/admin-api.json.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerHelp.test.cjs
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
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-help-'));
  tmpDirs.push(d);
  return d;
}

/** Starts a fake admin HTTP server answering GET /admin/mcp/readiness. */
function startFakeAdminServer(token, readinessBody) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad token' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(readinessBody));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Requires a fresh scheduler-mcp-server.cjs with TOKEN_PATH under `homeDir`. */
function requireServerWithHome(homeDir) {
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  delete require.cache[require.resolve(SERVER_PATH)];
  const mod = require(SERVER_PATH);
  process.env.HOME = originalHome;
  originalHome = undefined;
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

test('session_manager_help with no arguments returns grouped tool list + recipe titles + readiness', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const server = await startFakeAdminServer(token, { ok: true, ready: true, checks: [{ id: 'scheduler-mcp', ok: true }] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'session_manager_help', {});
  expect(result.isError).toBeFalsy();
  const body = JSON.parse(result.content[0].text);
  expect(Array.isArray(body.tools)).toBe(true);
  expect(body.tools.some((t) => t.name === 'session_manager_help')).toBe(true);
  expect(Array.isArray(body.recipes)).toBe(true);
  expect(body.recipes.some((r) => r.id === 'queue-work-via-develop')).toBe(true);
  expect(body.tool).toBeUndefined();
  expect(body.recipe).toBeUndefined();
  expect(body.readiness.available).toBe(true);
  expect(body.readiness.ok).toBe(true);
});

test('session_manager_help with a valid tool returns that entry including exampleArgs', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const server = await startFakeAdminServer(token, { ok: true, ready: true, checks: [] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'session_manager_help', { tool: 'scheduler_create_prd' });
  expect(result.isError).toBeFalsy();
  const body = JSON.parse(result.content[0].text);
  expect(body.tool.name).toBe('scheduler_create_prd');
  expect(body.tool.exampleArgs).toBeTruthy();
  expect(body.tools).toBeUndefined();
});

test('session_manager_help with a valid topic returns that recipe\'s steps', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const server = await startFakeAdminServer(token, { ok: true, ready: true, checks: [] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'session_manager_help', { topic: 'unstick-needs-review-job' });
  expect(result.isError).toBeFalsy();
  const body = JSON.parse(result.content[0].text);
  expect(body.recipe.id).toBe('unstick-needs-review-job');
  expect(Array.isArray(body.recipe.steps)).toBe(true);
  expect(body.recipe.steps.length).toBeGreaterThan(0);
});

test('session_manager_help accepts both tool and topic together, returning both sections', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const server = await startFakeAdminServer(token, { ok: true, ready: true, checks: [] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'session_manager_help', {
    tool: 'scheduler_list_jobs',
    topic: 'queue-work-via-develop',
  });
  expect(result.isError).toBeFalsy();
  const body = JSON.parse(result.content[0].text);
  expect(body.tool.name).toBe('scheduler_list_jobs');
  expect(body.recipe.id).toBe('queue-work-via-develop');
});

test('session_manager_help with an unknown tool returns a helpful error listing valid names', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'session_manager_help', { tool: 'not_a_real_tool' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('not_a_real_tool');
  expect(result.content[0].text).toContain('scheduler_create_prd');
  expect(result.content[0].text).toContain('call session_manager_help for the correct usage');
});

test('session_manager_help with an unknown topic returns a helpful error listing valid ids', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'session_manager_help', { topic: 'not-a-real-recipe' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('not-a-real-recipe');
  expect(result.content[0].text).toContain('queue-work-via-develop');
});

test('session_manager_help still returns the static catalog when the app is not running, with readiness unavailable', async () => {
  // No admin-api.json written under this tmp HOME at all — simulates the app
  // being down. The catalog is bundled in-process, so this must NOT fail
  // wholesale; only the readiness half degrades.
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'session_manager_help', {});
  expect(result.isError).toBeFalsy();
  const body = JSON.parse(result.content[0].text);
  expect(Array.isArray(body.tools)).toBe(true);
  expect(body.tools.length).toBeGreaterThan(0);
  expect(body.readiness.available).toBe(false);
  expect(typeof body.readiness.reason).toBe('string');
  expect(body.readiness.reason.length).toBeGreaterThan(0);
});

test('every isError return from the tool handler carries the session_manager_help pointer', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);

  const missingSlug = await callTool(handleCallTool, 'scheduler_reset_job', {});
  expect(missingSlug.isError).toBe(true);
  expect(missingSlug.content[0].text).toContain('call session_manager_help for the correct usage');

  const unknownTool = await callTool(handleCallTool, 'not_a_tool_at_all', {});
  expect(unknownTool.isError).toBe(true);
  expect(unknownTool.content[0].text).toContain('call session_manager_help for the correct usage');
});

test('NOT_RUNNING_ERROR (app not running) carries the pointer and is surfaced via isError', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool, NOT_RUNNING_ERROR } = requireServerWithHome(homeDir);
  expect(NOT_RUNNING_ERROR).toContain('call session_manager_help for the correct usage');

  const result = await callTool(handleCallTool, 'scheduler_list_jobs', {});
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe(NOT_RUNNING_ERROR);
});
