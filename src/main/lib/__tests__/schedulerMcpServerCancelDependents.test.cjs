/**
 * schedulerMcpServerCancelDependents.test.cjs — the MCP wire for PRD 3500:
 * scheduler_cancel_job forwards `dependents` (cancel-job-dependents-choice)
 * and scheduler_create_prd / each scheduler_create_prds entry forward
 * `allowDuplicateOf` (prd-create-refuses-cross-epic-duplicate) to the admin
 * route, and both fields are declared in the tools' input schemas.
 *
 * A real loopback HTTP server stands in for the admin API and records every
 * request body (same HOME-redirection pattern as
 * schedulerMcpServerGateFiles.test.cjs).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerCancelDependents.test.cjs
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
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-cancel-deps-'));
  tmpDirs.push(homeDir);
  const token = 'tok-cancel-deps';
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

const PRD_ARGS = {
  title: 'x', goal: 'y', acceptanceCriteria: ['z'], implementationNotes: 'n',
  gate: ['timeout 300 npm run typecheck'], files: ['src/main/lib/foo.cjs'],
};

test('scheduler_cancel_job forwards dependents to POST /admin/scheduler/cancel-job', async () => {
  const { mod, seen } = await setup({ ok: true });
  const dependents = { action: 'repoint', to: '3411-other-prd' };

  const result = await call(mod, 'scheduler_cancel_job', { slug: '3410-stuck', cwd: '/p', dependents });

  expect(result.isError).toBeFalsy();
  expect(seen).toHaveLength(1);
  expect(seen[0].method).toBe('POST');
  expect(seen[0].url).toBe('/admin/scheduler/cancel-job');
  expect(seen[0].body).toEqual({ slug: '3410-stuck', cwd: '/p', dependents });
});

test('scheduler_cancel_job without dependents sends no dependents field', async () => {
  const { mod, seen } = await setup({ ok: true });

  await call(mod, 'scheduler_cancel_job', { slug: '3410-stuck' });

  expect(seen).toHaveLength(1);
  expect(seen[0].body).toEqual({ slug: '3410-stuck' });
});

test('scheduler_create_prd forwards allowDuplicateOf to POST /admin/scheduler/create-prd', async () => {
  const { mod, seen } = await setup({ ok: true, slug: '3500-x', nn: 3500 });

  const result = await call(mod, 'scheduler_create_prd', { ...PRD_ARGS, allowDuplicateOf: ['3412-x'] });

  expect(result.isError).toBeFalsy();
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe('/admin/scheduler/create-prd');
  expect(seen[0].body.allowDuplicateOf).toEqual(['3412-x']);
});

test('scheduler_create_prds forwards each entry\'s allowDuplicateOf to POST /admin/scheduler/create-prds', async () => {
  const { mod, seen } = await setup({ ok: true, prds: [{ slug: 'a', nn: 1 }, { slug: 'b', nn: 2 }] });

  const result = await call(mod, 'scheduler_create_prds', {
    prds: [
      { ...PRD_ARGS, slug: 'a', allowDuplicateOf: ['3412-a', '3413-a'] },
      { ...PRD_ARGS, slug: 'b' },
    ],
  });

  expect(result.isError).toBeFalsy();
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe('/admin/scheduler/create-prds');
  expect(seen[0].body.prds[0].allowDuplicateOf).toEqual(['3412-a', '3413-a']);
  expect(seen[0].body.prds[1].allowDuplicateOf).toBeUndefined();
});

test('tool input schemas declare allowDuplicateOf and dependents', async () => {
  const { mod } = await setup({ ok: true });
  const byName = Object.fromEntries(mod.TOOLS.map((t) => [t.name, t]));

  const single = byName.scheduler_create_prd.inputSchema.properties.allowDuplicateOf;
  expect(single).toMatchObject({ type: 'array', items: { type: 'string' } });
  const entry = byName.scheduler_create_prds.inputSchema.properties.prds.items;
  expect(entry.properties.allowDuplicateOf).toMatchObject({ type: 'array' });

  const deps = byName.scheduler_cancel_job.inputSchema.properties.dependents;
  expect(deps.type).toBe('object');
  expect(deps.properties.action.enum).toEqual(['cascade', 'repoint', 'clear']);
  expect(deps.properties.to.type).toBe('string');
  expect(deps.required).toEqual(['action']);

  expect(byName.scheduler_create_prd.description).toMatch(/allowDuplicateOf/);
  expect(byName.scheduler_create_prds.description).toMatch(/allowDuplicateOf/);
  expect(byName.scheduler_cancel_job.description).toMatch(/dependents/);
});
