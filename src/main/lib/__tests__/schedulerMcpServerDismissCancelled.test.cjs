/**
 * schedulerMcpServerDismissCancelled.test.cjs — the MCP wire for
 * scheduler_dismiss_cancelled: forwards slug, cwd and dependents to
 * POST /admin/scheduler/dismiss-cancelled, returns the route's JSON as text,
 * and refuses a call without slug before any request.
 *
 * Pattern: schedulerMcpServerCancelDependents.test.cjs (real loopback server
 * standing in for the admin API, HOME redirected to a temp token file).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerDismissCancelled.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');

// A headless scheduled job (like the one that may run this test) carries env
// that makes the server refuse create/scoped tools; clear it per test.
const JOB_ENV = ['SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MAY_QUEUE', 'SM_SCHEDULER_JOB_MCP_TOOLS', 'SM_PROC_ROLE'];

const tmpDirs = [];
const servers = [];
let originalHome;
let savedEnv = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of JOB_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of JOB_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
  }
});

/** Fake admin server: records { method, url, body } of each request and answers with `responseBody`. */
function startRecordingServer(token, responseBody, seen) {
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
        seen.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseBody));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function setup(responseBody) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-dismiss-cancelled-'));
  tmpDirs.push(homeDir);
  const token = 'tok-dismiss-cancelled';
  const seen = [];
  const server = await startRecordingServer(token, responseBody, seen);
  servers.push(server);
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port: server.address().port, token }), 'utf8');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  delete require.cache[require.resolve(SERVER_PATH)];
  const mod = require(SERVER_PATH);
  return { mod, seen };
}

function call(mod, name, args) {
  return mod.handleCallTool({ params: { name, arguments: args } });
}

test('scheduler_dismiss_cancelled forwards slug, cwd and dependents to POST /admin/scheduler/dismiss-cancelled', async () => {
  const response = { ok: true, slug: '2005-dead', dismissedTo: '/x/prds-cancelled/ts' };
  const { mod, seen } = await setup(response);
  const dependents = { action: 'repoint', to: '2009-other' };

  const result = await call(mod, 'scheduler_dismiss_cancelled', { slug: '2005-dead', cwd: '/p', dependents });

  expect(result.isError).toBeFalsy();
  expect(seen).toHaveLength(1);
  expect(seen[0].method).toBe('POST');
  expect(seen[0].url).toBe('/admin/scheduler/dismiss-cancelled');
  expect(seen[0].body).toEqual({ slug: '2005-dead', cwd: '/p', dependents });
  expect(JSON.parse(result.content[0].text)).toEqual(response);
});

test('scheduler_dismiss_cancelled without slug is refused before any request', async () => {
  const { mod, seen } = await setup({ ok: true });
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...a) => { fetchCalls += 1; return realFetch(...a); };
  try {
    const result = await call(mod, 'scheduler_dismiss_cancelled', { cwd: '/p' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/missing required argument: slug/);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(fetchCalls).toBe(0);
  expect(seen).toHaveLength(0);
});

test('scheduler_dismiss_cancelled input schema matches scheduler_cancel_job\'s shape', async () => {
  const { mod } = await setup({ ok: true });
  const byName = Object.fromEntries(mod.TOOLS.map((t) => [t.name, t]));
  const tool = byName.scheduler_dismiss_cancelled;
  expect(tool).toBeDefined();
  expect(tool.inputSchema.required).toEqual(['slug']);
  expect(tool.inputSchema.properties.slug.type).toBe('string');
  expect(tool.inputSchema.properties.cwd.type).toBe('string');
  const deps = tool.inputSchema.properties.dependents;
  expect(deps.properties.action.enum).toEqual(['cascade', 'repoint', 'clear']);
  expect(deps.properties.to.type).toBe('string');
  expect(deps.required).toEqual(['action']);
  expect(tool.description.length).toBeGreaterThan(0);
});
