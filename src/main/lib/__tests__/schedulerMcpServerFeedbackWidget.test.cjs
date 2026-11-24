/**
 * schedulerMcpServerFeedbackWidget.test.cjs — the feedback_widget_create / _list / _update /
 * _delete / _snippet MCP tools wrapping the /admin/feedback-widget/* routes
 * (siteFeedbackAdminRoutes.cjs). Same HOME-repointing pattern as
 * schedulerMcpServerCustomerFeedback.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerFeedbackWidget.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { MCP_TOOL_CATALOG, composeDescription } = require('../mcpToolCatalog.cjs');

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
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-fw-'));
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

const HUMAN = { SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: undefined };
const JOB = { SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: 'some-job' };
const NO_SESSION = { SM_CHAT_SESSION_ID: undefined, SM_SCHEDULER_JOB_SLUG: undefined };
const PROJECT = '/home/me/site-project';

const ALL = ['feedback_widget_create', 'feedback_widget_list', 'feedback_widget_update', 'feedback_widget_delete', 'feedback_widget_snippet'];

function setProjectRoot(value) {
  originalProjectRoot = process.env.SM_PROJECT_ROOT === undefined ? null : process.env.SM_PROJECT_ROOT;
  process.env.SM_PROJECT_ROOT = value;
}

// ── schemas ──────────────────────────────────────────────────────────────────

test('all five tools are listed with catalog descriptions in the feedback-widget group', async () => {
  const { TOOLS } = requireServerWithHome(await mkTmp());
  for (const name of ALL) {
    const tool = TOOLS.find((t) => t.name === name);
    const entry = MCP_TOOL_CATALOG.find((e) => e.name === name);
    expect(tool).toBeTruthy();
    expect(entry.group).toBe('feedback-widget');
    expect(tool.description).toBe(composeDescription(entry));
  }
});

test('input schemas name the PRD args', async () => {
  const { TOOLS } = requireServerWithHome(await mkTmp());
  const byName = (n) => TOOLS.find((t) => t.name === n).inputSchema;
  const create = byName('feedback_widget_create');
  expect(create.required).toEqual(['label', 'allowedOrigins']);
  expect(Object.keys(create.properties).sort()).toEqual(['allowedOrigins', 'cwd', 'label']);
  expect(create.properties.allowedOrigins).toMatchObject({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 });
  const list = byName('feedback_widget_list');
  expect(list.required).toBeUndefined();
  expect(Object.keys(list.properties)).toEqual(['cwd']);
  const update = byName('feedback_widget_update');
  expect(update.required).toEqual(['boxId']);
  expect(Object.keys(update.properties).sort()).toEqual(['allowedOrigins', 'boxId', 'label', 'state']);
  expect(update.properties.state.enum).toEqual(['open', 'paused']);
  for (const n of ['feedback_widget_delete', 'feedback_widget_snippet']) {
    expect(byName(n).required).toEqual(['boxId']);
    expect(Object.keys(byName(n).properties)).toEqual(['boxId']);
  }
});

// ── route calls ──────────────────────────────────────────────────────────────

test('create posts cwd/label/allowedOrigins, cwd defaulting to SM_PROJECT_ROOT, and returns the snippet', async () => {
  const body = { ok: true, boxId: 'box_1', fingerprint: 'ab:cd', snippet: '<script src="x" data-box="box_1"></script>' };
  const { handleCallTool, requests } = await setup(body);
  setProjectRoot(PROJECT);
  const result = await withEnv(HUMAN, () => callTool(handleCallTool, 'feedback_widget_create', {
    label: 'Docs', allowedOrigins: ['https://docs.example.com'],
  }));
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual(body);
  expect(requests).toEqual([{
    method: 'POST',
    url: '/admin/feedback-widget/create',
    body: { cwd: PROJECT, label: 'Docs', allowedOrigins: ['https://docs.example.com'] },
  }]);
});

test('create forwards an explicit cwd', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, boxId: 'b', snippet: 's' });
  setProjectRoot(PROJECT);
  await withEnv(HUMAN, () => callTool(handleCallTool, 'feedback_widget_create', {
    label: 'Docs', allowedOrigins: ['https://a.example'], cwd: '/other/project',
  }));
  expect(requests[0].body.cwd).toBe('/other/project');
});

test('create rejects missing label or non-array origins without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true });
  for (const args of [{ allowedOrigins: ['https://a.example'] }, { label: 'x', allowedOrigins: 'https://a.example' }, { label: 'x', allowedOrigins: [1] }]) {
    const result = await withEnv(HUMAN, () => callTool(handleCallTool, 'feedback_widget_create', args));
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});

test('list GETs with cwd defaulting to SM_PROJECT_ROOT, or the given cwd', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, widgets: [] });
  setProjectRoot(PROJECT);
  const result = await callTool(handleCallTool, 'feedback_widget_list', {});
  expect(result.isError).toBeFalsy();
  await callTool(handleCallTool, 'feedback_widget_list', { cwd: '/x y/p' });
  expect(requests.map((r) => [r.method, r.url])).toEqual([
    ['GET', `/admin/feedback-widget/list?cwd=${encodeURIComponent(PROJECT)}`],
    ['GET', '/admin/feedback-widget/list?cwd=%2Fx+y%2Fp'],
  ]);
});

test('update posts only the given fields', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, widget: { boxId: 'box_1' } });
  const result = await withEnv(HUMAN, () => callTool(handleCallTool, 'feedback_widget_update', { boxId: 'box_1', state: 'paused' }));
  expect(result.isError).toBeFalsy();
  await withEnv(HUMAN, () => callTool(handleCallTool, 'feedback_widget_update', {
    boxId: 'box_1', label: 'New', allowedOrigins: ['https://b.example'],
  }));
  expect(requests).toEqual([
    { method: 'POST', url: '/admin/feedback-widget/update', body: { boxId: 'box_1', state: 'paused' } },
    { method: 'POST', url: '/admin/feedback-widget/update', body: { boxId: 'box_1', label: 'New', allowedOrigins: ['https://b.example'] } },
  ]);
});

test('update rejects a missing boxId, an empty patch and a bad state without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true });
  for (const args of [{ state: 'paused' }, { boxId: 'box_1' }, { boxId: 'box_1', state: 'closed' }, { boxId: 'box_1', allowedOrigins: 'x' }]) {
    const result = await withEnv(HUMAN, () => callTool(handleCallTool, 'feedback_widget_update', args));
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});

test('delete posts the boxId', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, boxId: 'box_1' });
  const result = await withEnv(HUMAN, () => callTool(handleCallTool, 'feedback_widget_delete', { boxId: 'box_1' }));
  expect(result.isError).toBeFalsy();
  expect(requests).toEqual([{ method: 'POST', url: '/admin/feedback-widget/delete', body: { boxId: 'box_1' } }]);
});

test('snippet GETs by boxId and rejects a missing one without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, boxId: 'box_1', snippet: 's' });
  const result = await callTool(handleCallTool, 'feedback_widget_snippet', { boxId: 'box_1' });
  expect(result.isError).toBeFalsy();
  const bad = await callTool(handleCallTool, 'feedback_widget_snippet', {});
  expect(bad.isError).toBe(true);
  expect(requests.map((r) => [r.method, r.url])).toEqual([['GET', '/admin/feedback-widget/snippet?boxId=box_1']]);
});

test.each(ALL)('%s returns an error result on {ok:false}', async (name) => {
  const { handleCallTool } = await setup({ ok: false, error: 'label must be 1-80 characters' });
  const args = { label: 'x', allowedOrigins: ['https://a.example'], boxId: 'box_1', state: 'open' };
  const result = await withEnv(HUMAN, () => callTool(handleCallTool, name, args));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('label must be 1-80 characters');
});

// ── headless refusal ─────────────────────────────────────────────────────────

const WRITE_CALLS = [
  ['feedback_widget_create', { label: 'x', allowedOrigins: ['https://a.example'] }],
  ['feedback_widget_update', { boxId: 'box_1', state: 'paused' }],
  ['feedback_widget_delete', { boxId: 'box_1' }],
];

test.each(WRITE_CALLS)('%s is refused in a headless scheduled job without a request', async (name, args) => {
  const { handleCallTool, requests } = await setup({ ok: true });
  const result = await withEnv(JOB, () => callTool(handleCallTool, name, args));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain(`refused: ${name} runs only in a Session Manager chat or terminal session`);
  expect(requests).toHaveLength(0);
});

test.each(WRITE_CALLS)('%s is refused without SM_CHAT_SESSION_ID without a request', async (name, args) => {
  const { handleCallTool, requests } = await setup({ ok: true });
  const result = await withEnv(NO_SESSION, () => callTool(handleCallTool, name, args));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('refused:');
  expect(requests).toHaveLength(0);
});

test('list and snippet work inside a headless scheduled job', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, widgets: [], snippet: 's' });
  setProjectRoot(PROJECT);
  const list = await withEnv(JOB, () => callTool(handleCallTool, 'feedback_widget_list', {}));
  const snip = await withEnv(NO_SESSION, () => callTool(handleCallTool, 'feedback_widget_snippet', { boxId: 'box_1' }));
  expect(list.isError).toBeFalsy();
  expect(snip.isError).toBeFalsy();
  expect(requests).toHaveLength(2);
});
