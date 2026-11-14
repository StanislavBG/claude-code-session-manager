/**
 * schedulerMcpServerCustomerFeedback.test.cjs — the customer_feedback_list /
 * customer_feedback_set_status MCP tools wrapping the customer-feedback admin routes.
 * Same HOME-repointing pattern as schedulerMcpServerProjectHome.test.cjs —
 * see that file's header for why.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerCustomerFeedback.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { MCP_TOOL_CATALOG, composeDescription } = require('../mcpToolCatalog.cjs');

const LIST_TOOL_NAME = 'customer_feedback_list';
const SAVE_TOOL_NAME = 'customer_feedback_set_status';

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
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-cf-'));
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

async function setup(body) {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, body);
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });
  return { ...requireServerWithHome(homeDir), requests };
}

test('both tools are listed with catalog descriptions', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  for (const name of [LIST_TOOL_NAME, SAVE_TOOL_NAME]) {
    const tool = TOOLS.find((t) => t.name === name);
    const entry = MCP_TOOL_CATALOG.find((e) => e.name === name);
    expect(tool).toBeTruthy();
    expect(tool.description).toBe(composeDescription(entry));
  }
  const setTool = TOOLS.find((t) => t.name === SAVE_TOOL_NAME);
  expect(setTool.inputSchema.required).toEqual(['id', 'status']);
  expect(setTool.inputSchema.properties.status.enum).toEqual(['open', 'in_progress', 'resolved', 'wontfix']);
});

test('list defaults pull to 1', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, items: [] });
  const result = await callTool(handleCallTool, LIST_TOOL_NAME, {});
  expect(result.isError).toBeFalsy();
  expect(requests[0].method).toBe('GET');
  expect(requests[0].url).toBe('/admin/customer-feedback/inbox?pull=1');
});

test('list pull:false and includeHidden:true are forwarded', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, items: [] });
  await callTool(handleCallTool, LIST_TOOL_NAME, { pull: false, includeHidden: true });
  expect(requests[0].url).toBe('/admin/customer-feedback/inbox?includeHidden=1');
});

test('list returns an error result on {ok:false}', async () => {
  const { handleCallTool } = await setup({ ok: false, error: 'Not configured as owner.' });
  const result = await callTool(handleCallTool, LIST_TOOL_NAME, {});
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Not configured as owner.');
});

test('set_status forwards id/status/note', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'a' } });
  const result = await callTool(handleCallTool, SAVE_TOOL_NAME, { id: 'a', status: 'resolved', note: 'done' });
  expect(result.isError).toBeFalsy();
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/customer-feedback/status');
  expect(requests[0].body).toEqual({ id: 'a', status: 'resolved', note: 'done' });
});

test('set_status omits empty note and rejects missing args without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  await callTool(handleCallTool, SAVE_TOOL_NAME, { id: 'a', status: 'open' });
  expect(requests[0].body).toEqual({ id: 'a', status: 'open' });
  const bad = await callTool(handleCallTool, SAVE_TOOL_NAME, { status: 'open' });
  expect(bad.isError).toBe(true);
  expect(requests).toHaveLength(1);
});

test('set_status returns an error result on {ok:false}', async () => {
  const { handleCallTool } = await setup({ ok: false, error: 'status must be one of: open' });
  const result = await callTool(handleCallTool, SAVE_TOOL_NAME, { id: 'a', status: 'bogus' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('status must be one of');
});

// ── customer_feedback_submit ─────────────────────────────────────────────────
const SUBMIT_TOOL_NAME = 'customer_feedback_submit';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('submit is listed with its catalog description and a required title/body/tag schema', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  const tool = TOOLS.find((t) => t.name === SUBMIT_TOOL_NAME);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === SUBMIT_TOOL_NAME);
  expect(tool).toBeTruthy();
  expect(entry.group).toBe('customer-feedback');
  expect(tool.description).toBe(composeDescription(entry));
  expect(tool.inputSchema.required).toEqual(['title', 'body', 'tag']);
  expect(tool.inputSchema.properties.tag.enum).toEqual(['bug', 'feature', 'discussion']);
});

test('submit forwards title/body/tag to the route in a human session', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'fb_1' } });
  const result = await withEnv({ SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: undefined }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { title: 'Panel: x', body: 'details', tag: 'feature' }));
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, item: { id: 'fb_1' } });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/customer-feedback/submit');
  expect(requests[0].body).toEqual({ title: 'Panel: x', body: 'details', tag: 'feature' });
});

test('submit returns an error result on {ok:false}', async () => {
  const { handleCallTool } = await setup({ ok: false, error: 'invalid submission: tag: bad' });
  const result = await withEnv({ SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: undefined }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { title: 't', body: 'b', tag: 'bug' }));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('invalid submission');
});

test('submit is refused in a headless scheduled job without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  const result = await withEnv({ SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: 'some-job' }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { title: 't', body: 'b', tag: 'bug' }));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('{F} feedback panel');
  expect(requests).toHaveLength(0);
});

test('submit is refused without SM_CHAT_SESSION_ID without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  const result = await withEnv({ SM_CHAT_SESSION_ID: undefined, SM_SCHEDULER_JOB_SLUG: undefined }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { title: 't', body: 'b', tag: 'bug' }));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('{F} feedback panel');
  expect(requests).toHaveLength(0);
});

test('submit rejects missing args without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  const result = await withEnv({ SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: undefined }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { title: 't', tag: 'bug' }));
  expect(result.isError).toBe(true);
  expect(requests).toHaveLength(0);
});
