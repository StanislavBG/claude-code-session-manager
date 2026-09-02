/**
 * schedulerMcpServerProjectHome.test.cjs — the four project_home_* MCP
 * tools (PRD: project-home-mcp-tools) that wrap PRD 1089's admin routes.
 * Covers: presence in TOOLS, catalog-composed descriptions, correct
 * route/payload dispatch via a stubbed admin HTTP server, cwd defaulting to
 * SM_PROJECT_ROOT/process.cwd() when omitted, the app-not-running failure
 * shape, and that project_home_get_contract's composed response is
 * self-sufficient (mentions all 5 lens ids, no repo-relative path).
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

const PROJECT_HOME_TOOL_NAMES = [
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

test('all four project_home_* tools are present in TOOLS with correct input schemas', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  for (const name of PROJECT_HOME_TOOL_NAMES) {
    const tool = TOOLS.find((t) => t.name === name);
    expect(tool).toBeTruthy();
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties.cwd).toBeTruthy();
    // cwd is never required on any of the four
    expect(tool.inputSchema.required ?? []).not.toContain('cwd');
  }
  const validate = TOOLS.find((t) => t.name === 'project_home_validate_summary');
  expect(validate.inputSchema.required).toContain('summary');
  const render = TOOLS.find((t) => t.name === 'project_home_render');
  expect(render.inputSchema.required).toEqual(expect.arrayContaining(['summary', 'picks']));
});

test.each(PROJECT_HOME_TOOL_NAMES)('%s description equals the catalog-composed string', async (name) => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  const tool = TOOLS.find((t) => t.name === name);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === name);
  expect(entry).toBeTruthy();
  expect(entry.group).toBe('project-home');
  expect(tool.description).toBe(composeDescription(entry));
});

test('project_home_get_contract dispatches GET /admin/project-home/contract with cwd query param', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, {
    ok: true,
    protocol: ['step one'],
    catalog: { lenses: [{ id: 'home' }, { id: 'marketing' }, { id: 'feature' }, { id: 'architecture' }, { id: 'brief' }] },
    paths: { summaryPath: '/abs/summary.json', picksPath: '/abs/picks.json', outputDir: '/abs/output' },
    spec: { text: 'spec text', path: '/abs/spec.md' },
  });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'project_home_get_contract', { cwd: '/home/bilko/Projects/session-manager' });
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  expect(requests[0].url).toBe('/admin/project-home/contract?cwd=%2Fhome%2Fbilko%2FProjects%2Fsession-manager');
});

test('project_home_get_contract composed response mentions all 5 lens ids and no repo-relative path', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server } = await startFakeAdminServer(token, {
    ok: true,
    protocol: [
      'Call GET /admin/project-home/status?cwd=<abs> first.',
      'Compose a ProjectPageSummary matching summarySchema.',
      'For each lens in catalog.lenses, pick a variant per slot.',
      'POST /admin/project-home/validate-summary with {cwd, summary}.',
      'POST /admin/project-home/render with {cwd, summary, picks}.',
    ],
    summarySchema: { type: 'object' },
    picksSchema: { type: 'object' },
    catalog: {
      lenses: [
        { id: 'home', slots: [] },
        { id: 'marketing', slots: [] },
        { id: 'feature', slots: [] },
        { id: 'architecture', slots: [] },
        { id: 'brief', slots: [] },
      ],
    },
    paths: { summaryPath: '/abs/project-pages/summary.json', picksPath: '/abs/project-pages/picks.json', outputDir: '/abs/project-pages/output' },
    spec: { text: 'This project uses absolute paths only, never repo-relative ones.', path: '/abs/project-pages-pipeline.md' },
  });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'project_home_get_contract', {});
  expect(result.isError).toBeFalsy();
  const text = result.content[0].text;
  for (const lens of ['home', 'marketing', 'feature', 'architecture', 'brief']) {
    expect(text).toContain(lens);
  }
  expect(text).not.toMatch(/session-manager-operations\/architecture\//);
  expect(text).not.toMatch(/\.claude\/agents\//);
});

test('project_home_validate_summary dispatches POST /admin/project-home/validate-summary with cwd+summary', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, valid: true, errors: [] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const summary = { title: 'Example Project' };
  const result = await callTool(handleCallTool, 'project_home_validate_summary', {
    cwd: '/home/bilko/Projects/session-manager',
    summary,
  });
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/project-home/validate-summary');
  expect(requests[0].body).toEqual({ cwd: '/home/bilko/Projects/session-manager', summary });
});

test('project_home_validate_summary surfaces per-field errors from the route, not a generic failure', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server } = await startFakeAdminServer(token, {
    ok: true,
    valid: false,
    errors: [{ field: 'quotes[0].attribution', message: 'quotes[0].attribution must not be a placeholder value' }],
  });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'project_home_validate_summary', {
    cwd: '/home/bilko/Projects/session-manager',
    summary: { title: 'x', quotes: [{ attribution: 'TODO' }] },
  });
  expect(result.isError).toBeFalsy();
  const body = JSON.parse(result.content[0].text);
  expect(body.valid).toBe(false);
  expect(body.errors).toEqual([
    { field: 'quotes[0].attribution', message: 'quotes[0].attribution must not be a placeholder value' },
  ]);
});

test('project_home_validate_summary requires summary', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'project_home_validate_summary', { cwd: '/x' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('summary');
});

test('project_home_render dispatches POST /admin/project-home/render with cwd+summary+picks', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, {
    ok: true,
    filesWritten: ['/abs/summary.json'],
    generatedAt: '2026-09-01T00:00:00.000Z',
  });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const summary = { title: 'Example Project' };
  const picks = { home: { hero: 'variant-a' } };
  const result = await callTool(handleCallTool, 'project_home_render', {
    cwd: '/home/bilko/Projects/session-manager',
    summary,
    picks,
  });
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/project-home/render');
  expect(requests[0].body).toEqual({ cwd: '/home/bilko/Projects/session-manager', summary, picks });
});

test('project_home_render requires both summary and picks', async () => {
  const homeDir = await mkTmp();
  const { handleCallTool } = requireServerWithHome(homeDir);

  const missingSummary = await callTool(handleCallTool, 'project_home_render', { picks: {} });
  expect(missingSummary.isError).toBe(true);
  expect(missingSummary.content[0].text).toContain('summary');

  const missingPicks = await callTool(handleCallTool, 'project_home_render', { summary: {} });
  expect(missingPicks.isError).toBe(true);
  expect(missingPicks.content[0].text).toContain('picks');
});

test('project_home_status dispatches GET /admin/project-home/status with cwd query param', async () => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, {
    ok: true,
    summary: { exists: false, mtimeMs: null },
    picks: { exists: false, mtimeMs: null },
    output: {
      home: { exists: false, mtimeMs: null },
      marketing: { exists: false, mtimeMs: null },
      feature: { exists: false, mtimeMs: null },
      architecture: { exists: false, mtimeMs: null },
      brief: { exists: false, mtimeMs: null },
    },
    manifest: { exists: false, generatedAt: null },
  });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  const { handleCallTool } = requireServerWithHome(homeDir);
  const result = await callTool(handleCallTool, 'project_home_status', { cwd: '/home/bilko/Projects/session-manager' });
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  expect(requests[0].url).toBe('/admin/project-home/status?cwd=%2Fhome%2Fbilko%2FProjects%2Fsession-manager');

  // Never-generated project: well-formed all-absent result, not an error.
  const body = JSON.parse(result.content[0].text);
  expect(body.ok).toBe(true);
  expect(body.summary.exists).toBe(false);
  expect(body.manifest.exists).toBe(false);
  expect(body.output.brief.exists).toBe(false);
});

test.each(PROJECT_HOME_TOOL_NAMES)('%s defaults cwd to SM_PROJECT_ROOT when omitted', async (name) => {
  const homeDir = await mkTmp();
  const token = 'test-token';
  const { server, requests } = await startFakeAdminServer(token, { ok: true, valid: true, errors: [] });
  servers.push(server);
  await writeAdminConfig(homeDir, { port: server.address().port, token });

  originalProjectRoot = process.env.SM_PROJECT_ROOT ?? null;
  process.env.SM_PROJECT_ROOT = '/home/bilko/Projects/session-manager/session-manager-operations/scheduler/epics/some-epic/worktree';

  const { handleCallTool } = requireServerWithHome(homeDir);
  const args = name === 'project_home_render' ? { summary: {}, picks: {} } : name === 'project_home_validate_summary' ? { summary: {} } : {};
  await callTool(handleCallTool, name, args);
  expect(requests).toHaveLength(1);
  const encoded = requests[0].body?.cwd ?? new URLSearchParams(requests[0].url.split('?')[1]).get('cwd');
  expect(encoded).toBe(process.env.SM_PROJECT_ROOT);
});

test.each(PROJECT_HOME_TOOL_NAMES)('%s returns the app-not-running error when the admin API is unreachable', async (name) => {
  const homeDir = await mkTmp();
  const { handleCallTool, NOT_RUNNING_ERROR } = requireServerWithHome(homeDir);
  const args = name === 'project_home_render' ? { summary: {}, picks: {} } : name === 'project_home_validate_summary' ? { summary: {} } : {};
  const result = await callTool(handleCallTool, name, args);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toBe(NOT_RUNNING_ERROR);
});
