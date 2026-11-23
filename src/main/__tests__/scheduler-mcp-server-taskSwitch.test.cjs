/**
 * scheduler-mcp-server-taskSwitch.test.cjs — the task_switch_set MCP tool:
 * refused before any request outside a human chat/terminal session (a
 * scheduled job, a Task or other internal headless run, or no session at all)
 * and on bad arguments; otherwise forwards to POST /admin/tasks/switch with
 * the caller identity taken from this process's env, never from arguments.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-mcp-server-taskSwitch.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../scripts/scheduler-mcp-server.cjs');
const ENV_KEYS = [
  'HOME', 'SM_CHAT_SESSION_ID', 'SM_PROJECT_ROOT', 'SM_SCHEDULER_JOB_SLUG',
  'SM_SCHEDULER_JOB_MCP_TOOLS', 'SM_KG_INTERNAL',
];

const tmpDirs = [];
const servers = [];
let savedEnv = null;

afterEach(async () => {
  if (savedEnv) {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    savedEnv = null;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) await new Promise((r) => servers.pop().close(r));
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function startFakeAdminServer(status, body) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

async function setup(env, { status = 200, body = { ok: true, cwd: '/p', enabled: true, changedAt: 't', by: 'agent', previous: false } } = {}) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-taskswitch-'));
  tmpDirs.push(homeDir);
  const { server, requests } = await startFakeAdminServer(status, body);
  servers.push(server);
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port: server.address().port, token: 't' }), 'utf8');
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = homeDir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve(SERVER_PATH)];
  return { ...require(SERVER_PATH), requests };
}

const QUOTE = "turn on 'Scripts may run Tasks' for burrow";
const BASE = { enabled: true, humanRequestQuote: QUOTE };
const call = (h, args) => h({ params: { name: 'task_switch_set', arguments: args } });

test('task_switch_set is a live MCP tool with the switch schema', async () => {
  const { TOOLS } = await setup({});
  const tool = TOOLS.find((t) => t.name === 'task_switch_set');
  expect(tool).toBeTruthy();
  expect(tool.inputSchema.required).toEqual(['enabled', 'humanRequestQuote']);
  expect(tool.inputSchema.properties.enabled.type).toBe('boolean');
  expect(tool.inputSchema.properties.humanRequestQuote.type).toBe('string');
  expect(tool.inputSchema.properties.cwd.type).toBe('string');
});

test.each([
  ['a scheduled job', { SM_CHAT_SESSION_ID: 's', SM_SCHEDULER_JOB_SLUG: '42-job' }, BASE],
  ['no chat session', {}, BASE],
  ['a Task / internal headless run', { SM_CHAT_SESSION_ID: 's', SM_KG_INTERNAL: '1' }, BASE],
])('refuses inside %s without making a request', async (_label, env, args) => {
  const { handleCallTool, requests } = await setup(env);
  const r = await call(handleCallTool, args);
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/refused: task_switch_set runs only in a Session Manager chat or terminal session/);
  expect(r.content[0].text).toMatch(/Scheduler → Tasks/);
  expect(requests).toHaveLength(0);
});

test.each([
  ['enabled missing', { humanRequestQuote: QUOTE }],
  ['enabled a string', { enabled: 'true', humanRequestQuote: QUOTE }],
  ['quote missing', { enabled: true }],
  ['quote empty', { enabled: true, humanRequestQuote: '' }],
  ['quote whitespace', { enabled: true, humanRequestQuote: '   ' }],
  ['quote not a string', { enabled: true, humanRequestQuote: 7 }],
  ['no args', undefined],
])('refuses bad arguments (%s) without making a request', async (_label, args) => {
  const { handleCallTool, requests } = await setup({ SM_CHAT_SESSION_ID: 's' });
  const r = await call(handleCallTool, args);
  expect(r.isError).toBe(true);
  expect(requests).toHaveLength(0);
});

test('forwards the body with caller identity replaced from env', async () => {
  const { handleCallTool, requests } = await setup({ SM_CHAT_SESSION_ID: 'real-sess', SM_PROJECT_ROOT: '/real/root' });
  const r = await call(handleCallTool, {
    ...BASE,
    cwd: '/home/x/burrow',
    originClaudeSessionId: 'forged-sess',
    originProjectRoot: '/forged/root',
  });
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/tasks/switch');
  expect(requests[0].body).toEqual({
    enabled: true,
    humanRequestQuote: QUOTE,
    originClaudeSessionId: 'real-sess',
    originProjectRoot: '/real/root',
    cwd: '/home/x/burrow',
  });
  expect(JSON.parse(r.content[0].text).ok).toBe(true);
});

test('omits cwd and originProjectRoot when not given, and drops forged identity', async () => {
  const { handleCallTool, requests } = await setup({ SM_CHAT_SESSION_ID: 'real-sess' });
  await call(handleCallTool, { enabled: false, humanRequestQuote: QUOTE, cwd: 42, originProjectRoot: '/forged' });
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toEqual({ enabled: false, humanRequestQuote: QUOTE, originClaudeSessionId: 'real-sess' });
});

test('an ok: false answer surfaces as isError with the error and reason', async () => {
  const { handleCallTool, requests } = await setup(
    { SM_CHAT_SESSION_ID: 'real-sess' },
    { status: 403, body: { ok: false, error: 'quote_does_not_name_switch', reason: 'the quote does not name the Scripts may run Tasks switch' } },
  );
  const r = await call(handleCallTool, BASE);
  expect(requests).toHaveLength(1);
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain('quote_does_not_name_switch');
  expect(r.content[0].text).toContain('the quote does not name the Scripts may run Tasks switch');
});

test('catalog documents task_switch_set in the tasks group', () => {
  const { MCP_TOOL_CATALOG, composeDescription } = require('../lib/mcpToolCatalog.cjs');
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'task_switch_set');
  expect(entry.group).toBe('tasks');
  expect(entry.whenToUse).toMatch(/only when the human asked in this chat/);
  expect(entry.whenToUse).toMatch(/verbatim/);
  expect(entry.whenNotToUse).toMatch(/own initiative/);
  expect(entry.whenNotToUse).toMatch(/job or script/);
  expect(entry.whenNotToUse).toMatch(/403 tasks_disabled/);
  expect(entry.notes).toMatch(/One instruction allows one change/);
  expect(entry.notes).toMatch(/reason/);
  expect(entry.exampleArgs).toEqual({ enabled: true, humanRequestQuote: QUOTE });
  expect(composeDescription(entry)).toContain('/admin/tasks/switch');
});
