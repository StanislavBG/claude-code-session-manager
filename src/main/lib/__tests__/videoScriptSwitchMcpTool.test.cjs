/**
 * videoScriptSwitchMcpTool.test.cjs — the video_script_switch_set MCP tool
 * (POST /admin/project-home/videos/script-switch) and the
 * 'script-press-demo-video' session_manager_help recipe.
 * Same HOME-repointing pattern as schedulerMcpServerTasks.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/videoScriptSwitchMcpTool.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');
const { MCP_TOOL_CATALOG, MCP_RECIPES, composeDescription } = require('../mcpToolCatalog.cjs');

const ENV_KEYS = ['HOME', 'SM_SCHEDULER_JOB_MCP_TOOLS', 'SM_SCHEDULER_JOB_SLUG', 'SM_CHAT_SESSION_ID', 'SM_KG_INTERNAL', 'SM_PROJECT_ROOT'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const tmpDirs = [];
const servers = [];

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

async function mkTmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-vss-'));
  tmpDirs.push(d);
  return d;
}

function startFakeAdminServer(token, body) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad token' }));
          return;
        }
        requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

async function harness(env, body = { ok: true, enabled: true }) {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, body);
  servers.push(server);
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port: server.address().port, token }), 'utf8');
  for (const k of ENV_KEYS) if (k !== 'HOME') delete process.env[k];
  process.env.HOME = homeDir;
  Object.assign(process.env, env);
  delete require.cache[require.resolve(SERVER_PATH)];
  return { ...require(SERVER_PATH), requests };
}

const call = (h, name, args) => h.handleCallTool({ params: { name, arguments: args } });
const ARGS = { enabled: true, humanRequestQuote: "turn on 'Scripts may run Demo Video' for burrow" };

test('catalog entry: project-home group, names the switch, quote rule and job/Task refusal', async () => {
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'video_script_switch_set');
  expect(entry).toBeTruthy();
  expect(entry.group).toBe('project-home');
  expect(entry.purpose).toContain("'Scripts may run Demo Video'");
  expect(entry.purpose).toContain('/admin/project-home/videos/script-switch');
  expect(entry.purpose).toMatch(/scheduled job, a Task/);
  expect(entry.whenToUse).toMatch(/verbatim/);
  const { TOOLS } = await harness({});
  const tool = TOOLS.find((t) => t.name === 'video_script_switch_set');
  expect(tool.inputSchema.required).toEqual(['enabled', 'humanRequestQuote']);
  expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['cwd', 'enabled', 'humanRequestQuote']);
  expect(tool.description).toBe(composeDescription(entry));
});

test('recipe script-press-demo-video walks switch, run, status, 409 and review', () => {
  const recipe = MCP_RECIPES.find((r) => r.id === 'script-press-demo-video');
  expect(recipe).toBeTruthy();
  const text = recipe.steps.join('\n');
  expect(text).toContain("'Scripts may run Demo Video'");
  expect(text).toContain('Project Home > Video');
  expect(text).toContain('video_script_switch_set');
  expect(text).toContain('/admin/project-home/videos/run');
  expect(text).toMatch(/curl .*jq -r \.port ~\/\.claude\/session-manager\/admin-api\.json/);
  expect(text).toMatch(/\.token/);
  expect(text).toContain('"kind":"Blog post"');
  expect(text).toContain('"externalRef"');
  expect(text).toContain('/admin/project-home/videos/status?cwd=');
  expect(text).toContain('409 already_building');
  expect(text).toMatch(/Review first/);
});

for (const [label, env] of [
  ['a scheduled job', { SM_SCHEDULER_JOB_SLUG: '01-x', SM_CHAT_SESSION_ID: 'chat-1' }],
  ['a Task / internal headless run', { SM_KG_INTERNAL: '1', SM_CHAT_SESSION_ID: 'chat-1' }],
  ['a process outside a chat session', {}],
]) {
  test(`refused inside ${label}, exactly like task_switch_set, with no request`, async () => {
    const h = await harness(env);
    const video = await call(h, 'video_script_switch_set', ARGS);
    const task = await call(h, 'task_switch_set', { ...ARGS, humanRequestQuote: "turn on 'Scripts may run Tasks'" });
    expect(video.isError).toBe(true);
    expect(task.isError).toBe(true);
    expect(video.content[0].text).toMatch(/^refused: video_script_switch_set runs only in a Session Manager chat or terminal session/);
    expect(h.requests).toEqual([]);
  });
}

test('in a chat session it POSTs the script-switch route with identity from env only', async () => {
  const h = await harness({ SM_CHAT_SESSION_ID: 'chat-1', SM_PROJECT_ROOT: '/home/u/burrow' });
  const res = await call(h, 'video_script_switch_set', { ...ARGS, originClaudeSessionId: 'forged', originProjectRoot: '/x' });
  expect(res.isError).toBeFalsy();
  expect(h.requests).toEqual([{
    method: 'POST',
    url: '/admin/project-home/videos/script-switch',
    body: { enabled: true, humanRequestQuote: ARGS.humanRequestQuote, originClaudeSessionId: 'chat-1', originProjectRoot: '/home/u/burrow' },
  }]);
  const withCwd = await call(h, 'video_script_switch_set', { ...ARGS, cwd: '/home/u/other' });
  expect(withCwd.isError).toBeFalsy();
  expect(h.requests[1].body.cwd).toBe('/home/u/other');
  const bad = await call(h, 'video_script_switch_set', { enabled: 'yes', humanRequestQuote: 'x' });
  expect(bad.isError).toBe(true);
});
