/**
 * scheduler-mcp-server-feedbackReply.test.cjs — the feedback_reply MCP tool:
 * caller-supplied identity is stripped and replaced from this process's env,
 * a scheduled job is refused before any request, and the result note names
 * the delivery honestly (never that the other project acted).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-mcp-server-feedbackReply.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../scripts/scheduler-mcp-server.cjs');
const ENV_KEYS = ['HOME', 'SM_CHAT_SESSION_ID', 'SM_PROJECT_ROOT', 'SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MCP_TOOLS'];

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

function startFakeAdminServer(body) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

async function setup(body, env) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-reply-'));
  tmpDirs.push(homeDir);
  const { server, requests } = await startFakeAdminServer(body);
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

const BASE = { message: 'Done — fixed in abc123.', outcome: 'done' };
const call = (h, args) => h({ params: { name: 'feedback_reply', arguments: args } });

test('feedback_reply is a live MCP tool with the reply contract schema', async () => {
  const { TOOLS } = await setup({ ok: true }, {});
  const tool = TOOLS.find((t) => t.name === 'feedback_reply');
  expect(tool).toBeTruthy();
  expect(tool.inputSchema.required).toEqual(['message', 'outcome']);
  expect(tool.inputSchema.properties.outcome.enum).toEqual(['done', 'blocked', 'question']);
  expect(tool.inputSchema.properties.referencePaths.items.type).toBe('string');
  expect(tool.inputSchema.properties.toEpicId.type).toBe('string');
});

test('strips caller-supplied identity and stamps it from the env', async () => {
  const { handleCallTool, requests } = await setup(
    { ok: true, delivery: 'delivered' },
    { SM_CHAT_SESSION_ID: 'real-sess', SM_PROJECT_ROOT: '/real/root' },
  );
  await call(handleCallTool, {
    ...BASE,
    originClaudeSessionId: 'forged-sess',
    originProjectRoot: '/forged/root',
    fromCwd: '/forged/cwd',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/feedback/reply');
  expect(requests[0].body.originClaudeSessionId).toBe('real-sess');
  expect(requests[0].body.originProjectRoot).toBe('/real/root');
  expect(requests[0].body.fromCwd).toBe(process.cwd());
  expect(requests[0].body.message).toBe(BASE.message);
  expect(requests[0].body.outcome).toBe('done');
});

test('with no env identity, forged identity is dropped, not forwarded', async () => {
  const { handleCallTool, requests } = await setup({ ok: false, error: 'no identity' }, {});
  await call(handleCallTool, { ...BASE, originClaudeSessionId: 'forged', originProjectRoot: '/forged' });
  expect(requests[0].body).not.toHaveProperty('originClaudeSessionId');
  expect(requests[0].body).not.toHaveProperty('originProjectRoot');
});

test('refuses inside a scheduled job without making a request', async () => {
  const { handleCallTool, requests } = await setup(
    { ok: true, delivery: 'delivered' },
    { SM_CHAT_SESSION_ID: 'real-sess', SM_SCHEDULER_JOB_SLUG: '42-some-job' },
  );
  const r = await call(handleCallTool, BASE);
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/refused/);
  expect(r.content[0].text).toMatch(/result/);
  expect(requests).toHaveLength(0);
});

test.each([
  ['delivered', 'delivered into the asking session'],
  ['event-only', 'delivered as an event only'],
  ['fallback', 'fell back to a new proposed session'],
])('delivery %s gets an honest note', async (delivery, phrase) => {
  const { handleCallTool } = await setup({ ok: true, delivery }, { SM_CHAT_SESSION_ID: 's' });
  const r = await call(handleCallTool, BASE);
  expect(r.content[0].text).toContain(phrase);
  expect(r.content[0].text).not.toMatch(/fixed it|has acted|is working on it/i);
});

test('event-only delivery the asker requested says it was recorded as an event for the asking app, no chat prompted', async () => {
  const { handleCallTool } = await setup({ ok: true, delivery: 'event-only', reason: 'asker-requested-event' }, { SM_CHAT_SESSION_ID: 's' });
  const r = await call(handleCallTool, BASE);
  const text = r.content[0].text;
  expect(text).toContain('recorded as an event for the asking app');
  expect(text).toContain('no chat was prompted');
  expect(text).not.toContain('delivered as an event only on the asking Epic');
});

test('catalog documents feedback_reply and drops the "no reply channel" wording', () => {
  const { MCP_TOOL_CATALOG, MCP_RECIPES, composeDescription } = require('../lib/mcpToolCatalog.cjs');
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_reply');
  expect(entry.group).toBe('feedback');
  const text = composeDescription(entry);
  expect(text).toMatch(/feedback_open_session/);
  expect(text).toMatch(/Epic that asked/);
  expect(text).toMatch(/refused/);
  expect(text).toMatch(/3 replies per thread/);
  expect(text).toMatch(/verified/);
  const open = composeDescription(MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_open_session'));
  expect(open).not.toMatch(/no reply channel|no callback/i);
  expect(open).toContain('feedback_reply');
  const handOff = MCP_RECIPES.find((r) => r.id === 'hand-finding-to-another-project').steps.join(' ');
  expect(handOff).not.toMatch(/no reply channel|no callback/i);
  expect(handOff).toContain('feedback_reply');
  expect(MCP_RECIPES.find((r) => r.id === 'reply-to-the-project-that-asked').steps.length).toBeGreaterThan(0);
});

// feedback_open_session: the MCP note promises a feedback_reply thread only
// when the server says one was stamped (result.replyThread === true).
const REPLY_SENTENCE = 'The receiving session can answer into this Epic with feedback_reply.';
const NO_REPLY_SENTENCE = ' No reply path: Session Manager could not identify the sending session, so no answer will come back here; ask the human to follow up.';
const OPEN_ARGS = { toCwd: '/p/to', fromCwd: '/p/from', title: 't', body: 'b' };
const openCall = (h) => h({ params: { name: 'feedback_open_session', arguments: OPEN_ARGS } });

test.each([
  ['auto-approved', true],
  ['auto-approved', false],
  ['auto-approved', undefined],
  ['proposed', true],
  ['proposed', false],
  ['proposed', undefined],
])('feedback_open_session %s with replyThread %s gets a truthful reply note', async (status, replyThread) => {
  const body = { ok: true, status, epicId: 'e1' };
  if (replyThread !== undefined) body.replyThread = replyThread;
  const { handleCallTool } = await setup(body, {});
  const text = (await openCall(handleCallTool)).content[0].text;
  if (replyThread === true) {
    expect(text).toContain(REPLY_SENTENCE);
    expect(text).not.toContain(NO_REPLY_SENTENCE);
  } else {
    expect(text).not.toContain('can answer into this Epic with feedback_reply');
    expect(text).toContain(NO_REPLY_SENTENCE);
  }
  expect(text).toContain(status === 'auto-approved' ? 'auto-approved and is starting' : 'PROPOSED session');
});

test('feedback_open_session catalog limits the feedback_reply promise to an identified Epic chat session', () => {
  const { MCP_TOOL_CATALOG, composeDescription } = require('../lib/mcpToolCatalog.cjs');
  const open = composeDescription(MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_open_session'));
  expect(open).toMatch(/only when the call comes from a Session Manager Epic chat session that Session Manager can identify/);
});
