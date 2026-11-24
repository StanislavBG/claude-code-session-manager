/**
 * scheduler-mcp-server-slots.test.cjs — the scheduler_slots_get /
 * scheduler_slots_set MCP tools: request shapes sent to GET/POST
 * /admin/scheduler/slots, caller identity taken from this process's env
 * (never from arguments), argument refusals before any request, and the
 * route's ok:false answers passed through as isError with error + reason.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-mcp-server-slots.test.cjs
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

async function setup(env, { status = 200, body = { ok: true } } = {}) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-slots-'));
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

const QUOTE = 'raise the limit to 14';
const call = (h, name, args) => h({ params: { name, arguments: args } });

test('both tools are live MCP tools with the slots schemas', async () => {
  const { TOOLS } = await setup({});
  const get = TOOLS.find((t) => t.name === 'scheduler_slots_get');
  expect(get).toBeTruthy();
  expect(get.inputSchema.required).toBeUndefined();
  expect(Object.keys(get.inputSchema.properties)).toEqual([]);
  const set = TOOLS.find((t) => t.name === 'scheduler_slots_set');
  expect(set).toBeTruthy();
  expect(set.inputSchema.required).toEqual(['cap', 'quote']);
  expect(set.inputSchema.properties.cap.type).toBe('integer');
  expect(set.inputSchema.properties.quote.type).toBe('string');
  expect(set.description).toMatch(/human's own words/);
  expect(set.description).toMatch(/verbatim from this session/);
  expect(set.description).toContain('"raise the limit to 14"');
  expect(set.inputSchema.properties.quote.description).toContain("'raise the limit to 14'");
});

test('scheduler_slots_get sends GET /admin/scheduler/slots with no body and returns the answer', async () => {
  const answer = { ok: true, cap: 8, min: 1, max: 32, inUse: 3, available: 5 };
  const { handleCallTool, requests } = await setup({}, { body: answer });
  const r = await call(handleCallTool, 'scheduler_slots_get', {});
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  expect(requests[0].url).toBe('/admin/scheduler/slots');
  expect(requests[0].body).toBeUndefined();
  expect(JSON.parse(r.content[0].text)).toEqual(answer);
});

test('scheduler_slots_get passes an ok: false answer through as isError', async () => {
  const { handleCallTool } = await setup({}, { status: 500, body: { ok: false, error: 'boom', reason: 'slots unreadable' } });
  const r = await call(handleCallTool, 'scheduler_slots_get', undefined);
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain('boom');
  expect(r.content[0].text).toContain('slots unreadable');
});

test('scheduler_slots_set forwards cap + quote with identity from env, dropping forged identity', async () => {
  const { handleCallTool, requests } = await setup(
    { SM_CHAT_SESSION_ID: 'real-sess', SM_PROJECT_ROOT: '/real/root' },
    { body: { ok: true, from: 8, to: 14 } },
  );
  const r = await call(handleCallTool, 'scheduler_slots_set', {
    cap: 14,
    quote: QUOTE,
    originClaudeSessionId: 'forged',
    originProjectRoot: '/forged',
    callerJobSlug: 'forged-job',
  });
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/scheduler/slots');
  expect(requests[0].body).toEqual({
    cap: 14,
    quote: QUOTE,
    originClaudeSessionId: 'real-sess',
    originProjectRoot: '/real/root',
  });
  expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, from: 8, to: 14 });
});

// Refusal parity with task_switch_set: both tools go through one local helper
// (humanSessionRefusal + the SM_KG_INTERNAL check), so each env below refuses
// BOTH tools, before any request reaches the admin API.
const REFUSING_ENVS = [
  ['outside a chat session', {}],
  ['inside a scheduled job', { SM_CHAT_SESSION_ID: 'real-sess', SM_SCHEDULER_JOB_SLUG: '42-job' }],
  ['inside a scheduled job with no chat session', { SM_SCHEDULER_JOB_SLUG: '42-job' }],
  ['inside an internal headless run', { SM_CHAT_SESSION_ID: 'real-sess', SM_KG_INTERNAL: '1' }],
];

test.each(REFUSING_ENVS)('scheduler_slots_set and task_switch_set both refuse locally %s', async (_label, env) => {
  const { handleCallTool, requests } = await setup(env, { body: { ok: true } });
  const slots = await call(handleCallTool, 'scheduler_slots_set', { cap: 14, quote: QUOTE });
  const tasks = await call(handleCallTool, 'task_switch_set', { enabled: true, humanRequestQuote: 'turn on tasks' });
  expect(slots.isError).toBe(true);
  expect(tasks.isError).toBe(true);
  expect(slots.content[0].text).toMatch(/^refused: scheduler_slots_set runs only in a Session Manager chat or terminal session/);
  expect(tasks.content[0].text).toMatch(/^refused: task_switch_set runs only in a Session Manager chat or terminal session/);
  expect(requests).toHaveLength(0);
});

test('scheduler_slots_set and task_switch_set both reach the route in a human chat session', async () => {
  const { handleCallTool, requests } = await setup({ SM_CHAT_SESSION_ID: 'real-sess', SM_KG_INTERNAL: '0' }, { body: { ok: true } });
  const slots = await call(handleCallTool, 'scheduler_slots_set', { cap: 14, quote: QUOTE });
  const tasks = await call(handleCallTool, 'task_switch_set', { enabled: true, humanRequestQuote: 'turn on tasks' });
  expect(slots.isError).toBeFalsy();
  expect(tasks.isError).toBeFalsy();
  expect(requests.map((r) => r.url)).toEqual(['/admin/scheduler/slots', '/admin/tasks/switch']);
});

test('scheduler_slots_set refuses bad arguments only after the session refusal', async () => {
  const { handleCallTool, requests } = await setup({ SM_SCHEDULER_JOB_SLUG: '42-job', SM_CHAT_SESSION_ID: 's' });
  const r = await call(handleCallTool, 'scheduler_slots_set', undefined);
  expect(r.content[0].text).toMatch(/^refused: scheduler_slots_set/);
  expect(requests).toHaveLength(0);
});

test.each([
  ['human_request_unverified', 'quote was not found in a prompt the human typed in this chat session'],
  ['quote_does_not_name_slots', "the human's quote does not name the session limit and the number 14"],
])('scheduler_slots_set passes the route refusal %s through with its reason', async (error, reason) => {
  const { handleCallTool, requests } = await setup(
    { SM_CHAT_SESSION_ID: 'real-sess' },
    { status: 403, body: { ok: false, error, reason } },
  );
  const r = await call(handleCallTool, 'scheduler_slots_set', { cap: 14, quote: QUOTE });
  expect(requests).toHaveLength(1);
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain(`${error}: ${reason}`);
});

test('scheduler_slots_set passes a 400 invalid_request with details through', async () => {
  const { handleCallTool } = await setup(
    { SM_CHAT_SESSION_ID: 'real-sess' },
    { status: 400, body: { ok: false, error: 'invalid_request', details: 'cap must be an integer in [1, 32]' } },
  );
  const r = await call(handleCallTool, 'scheduler_slots_set', { cap: 99, quote: 'set the limit to 99' });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain('invalid_request');
  expect(r.content[0].text).toContain('cap must be an integer in [1, 32]');
});

test('scheduler_slots_set outside a chat session is refused without a request', async () => {
  const { handleCallTool, requests } = await setup({});
  const r = await call(handleCallTool, 'scheduler_slots_set', { cap: 14, quote: QUOTE });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/refused: scheduler_slots_set/);
  expect(requests).toHaveLength(0);
});

test.each([
  ['cap missing', { quote: QUOTE }],
  ['cap a string', { cap: '14', quote: QUOTE }],
  ['cap not an integer', { cap: 14.5, quote: QUOTE }],
  ['quote missing', { cap: 14 }],
  ['quote empty', { cap: 14, quote: '' }],
  ['quote whitespace', { cap: 14, quote: '   ' }],
  ['quote not a string', { cap: 14, quote: 14 }],
  ['no args', undefined],
])('scheduler_slots_set refuses bad arguments (%s) without a request', async (_label, args) => {
  const { handleCallTool, requests } = await setup({ SM_CHAT_SESSION_ID: 's' });
  const r = await call(handleCallTool, 'scheduler_slots_set', args);
  expect(r.isError).toBe(true);
  expect(requests).toHaveLength(0);
});
