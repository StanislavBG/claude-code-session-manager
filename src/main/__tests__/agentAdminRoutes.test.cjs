/**
 * agentAdminRoutes.test.cjs — the read-only persona roster route
 * GET /admin/agents, with injected listPersonas + resolver functions.
 * Follows epicAdminRoutes.test.cjs: a fake adminHttp captures handlers and a
 * fake response object records the answer.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/agentAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerAdminRoute } = require('../lib/persona-macro/agentAdminRoutes.cjs');
const { schemas } = require('../ipcSchemas.cjs');

const tmpDirs = [];

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function fakeAdminHttp() {
  const routes = new Map();
  return {
    routes,
    registerRoute(method, p, handler) { routes.set(`${method} ${p}`, handler); },
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { if (chunk) this.body += String(chunk); },
    get json() { return JSON.parse(this.body); },
  };
}

function persona(name, overrides = {}) {
  return {
    name,
    description: `desc ${name}`,
    tools: ['Read'],
    model: 'opus',
    effort: 'high',
    color: 'blue',
    tags: ['feature'],
    projects: [],
    action: null,
    actionLabel: null,
    title: `Title ${name}`,
    seedVersion: 3,
    executorOnly: false,
    agentCli: null,
    agentCliModel: null,
    path: `/home/x/.claude/agents/${name}.md`,
    body: `SECRET BODY of ${name}`,
    overridingProjects: ['proj'],
    overrideDetails: [{ project: 'proj', cwd: '/p', fields: ['model'], values: { model: 'haiku' }, bodyOverridden: true, issue: null }],
    ...overrides,
  };
}

async function project() {
  const cwd = await mkTmp('sm-agent-routes-cwd-');
  fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
  return cwd;
}

function setup(deps) {
  const http = fakeAdminHttp();
  registerAdminRoute(http, deps);
  return http;
}

async function call(http, params) {
  const handler = http.routes.get('GET /admin/agents');
  if (!handler) throw new Error('no route GET /admin/agents');
  const res = fakeRes();
  await handler({}, res, new URLSearchParams(params));
  return res;
}

const PUBLIC_KEYS = ['agentCli', 'agentCliModel', 'description', 'effort', 'executorOnly', 'model', 'name', 'path', 'seedVersion', 'tags', 'title', 'tools'];

test('the query schema is exported', () => {
  expect(schemas.adminListAgentsQuery).toBeDefined();
  expect(schemas.adminListAgentsQuery.parse({})).toEqual({});
});

test('registers exactly GET /admin/agents', () => {
  const http = setup({});
  expect([...http.routes.keys()]).toEqual(['GET /admin/agents']);
});

test('without cwd: 200, sorted by name, public fields only, no resolved key', async () => {
  let resolverCalls = 0;
  const http = setup({
    listPersonas: async () => [persona('zeta'), persona('alpha'), persona('mid')],
    resolveEffectiveModelInfo: async () => { resolverCalls += 1; return {}; },
  });
  const res = await call(http, {});
  expect(res.statusCode).toBe(200);
  const body = res.json;
  expect(body.ok).toBe(true);
  expect(body.agents.map((a) => a.name)).toEqual(['alpha', 'mid', 'zeta']);
  for (const a of body.agents) {
    expect(Object.keys(a).sort()).toEqual(PUBLIC_KEYS);
    expect('resolved' in a).toBe(false);
  }
  expect(body.agents[0]).toMatchObject({ title: 'Title alpha', model: 'opus', effort: 'high', seedVersion: 3, path: '/home/x/.claude/agents/alpha.md' });
  expect(res.body).not.toContain('SECRET BODY');
  expect(res.body).not.toContain('overrideDetails');
  expect(resolverCalls).toBe(0);
});

test('with cwd: each agent carries resolved; a throwing resolution gives resolved: null', async () => {
  const cwd = await project();
  const seen = [];
  const http = setup({
    listPersonas: async () => [persona('beta'), persona('alpha'), persona('broken')],
    resolveEffectiveModelInfo: async ({ cwd: c, agentType }) => {
      seen.push([c, agentType]);
      if (agentType === 'broken') throw new Error('boom');
      return {
        modelAlias: 'opus',
        modelSource: 'persona',
        resolvedModelId: `claude-${agentType}`,
        personaEffort: 'medium',
        personaEffortSource: 'persona',
      };
    },
  });
  const res = await call(http, { cwd });
  expect(res.statusCode).toBe(200);
  const { agents } = res.json;
  expect(agents.map((a) => a.name)).toEqual(['alpha', 'beta', 'broken']);
  expect(agents[0].resolved).toEqual({ modelId: 'claude-alpha', modelSource: 'persona', effort: 'medium', effortSource: 'persona' });
  expect(agents[1].resolved).toEqual({ modelId: 'claude-beta', modelSource: 'persona', effort: 'medium', effortSource: 'persona' });
  expect(agents[2].resolved).toBeNull();
  expect(seen.map((s) => s[0]).every((c) => c === cwd)).toBe(true);
  expect(seen.map((s) => s[1]).sort()).toEqual(['alpha', 'beta', 'broken']);
  expect(res.body).not.toContain('SECRET BODY');
});

test('a relative cwd answers 400 naming the reason', async () => {
  const http = setup({ listPersonas: async () => [persona('a')], resolveEffectiveModelInfo: async () => ({}) });
  const res = await call(http, { cwd: 'relative/path' });
  expect(res.statusCode).toBe(400);
  expect(res.json).toEqual({ ok: false, error: 'cwd must be an absolute path' });
});

test('a cwd with no session-manager-operations folder answers 400 naming the reason', async () => {
  const cwd = await mkTmp('sm-agent-routes-bare-');
  const http = setup({ listPersonas: async () => [persona('a')], resolveEffectiveModelInfo: async () => ({}) });
  const res = await call(http, { cwd });
  expect(res.statusCode).toBe(400);
  expect(res.json).toEqual({ ok: false, error: 'cwd has no session-manager-operations folder' });
});
