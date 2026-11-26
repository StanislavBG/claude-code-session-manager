/**
 * prdBatch-plan-review.test.cjs — createPrdBatch stamps planReview: required on a
 * qualifying validator PRD; end to end: MCP tool input → handleCallTool → (stubbed fetch) → the REAL
 * /admin/scheduler/create-prds route (schema parse + createPrdBatch) → the
 * written PRD file. Valid, invalid and absent preflight, plus the incident
 * shape (PRD 3805, 2026-11-23): a running app that predates preflight drops
 * the key silently, so the batch must be refused, never written without it.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdBatch-plan-review.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const config = require('../../../config.cjs');
const { registerAdminRoute } = require('../prdCreate.cjs');
const { parsePrdFile } = require('../prdFrontmatter.cjs');
const { handleCallTool } = require('../../../../../scripts/scheduler-mcp-server.cjs');

const ENV_KEYS = ['SM_PLAN_REVIEW', 'SM_ADMIN_TOKEN_PATH', 'SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MAY_QUEUE', 'SM_CHAT_SESSION_ID', 'SM_PROJECT_ROOT'];
const saved = {};
let cwd;
let outDir;
let nextNn;
let routes;
let fetches;
let mutateBody;

function writeAdminConfig(extra) {
  fs.writeFileSync(process.env.SM_ADMIN_TOKEN_PATH, JSON.stringify({ port: 4321, token: 'tok', ...extra }));
}

beforeEach(async () => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-batch-planrev-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.mkdir(path.join(cwd, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.claude', 'agents', 'validator.md'), '---\nname: validator\ndescription: validator\n---\nv\n');
  config.addAllowedRoot(cwd);
  process.env.SM_ADMIN_TOKEN_PATH = path.join(cwd, 'admin-api.json');
  writeAdminConfig({ appVersion: '0.142.0' });
  nextNn = 900;
  fetches = 0;
  mutateBody = null;
  const remote = {
    async allocateParallelGroup() { return nextNn++; },
    async readPrd() { return { ok: false }; },
    async writePrd(slug, body) {
      const p = path.join(outDir, `${slug}.md`);
      await fsp.writeFile(p, body);
      return { ok: true, path: p };
    },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
  };
  routes = new Map();
  registerAdminRoute({ registerRoute: (method, url, handler) => routes.set(`${method} ${url}`, handler) }, remote);
  // The admin HTTP transport, in-process: the real route handler reads the
  // request body from a stream and answers through res.writeHead/res.end.
  vi.stubGlobal('fetch', async (url, init) => {
    fetches++;
    const handler = routes.get(`${init.method} ${new URL(url).pathname}`);
    if (!handler) return { status: 404, json: async () => ({ ok: false, error: 'not found' }) };
    let body = init.body;
    if (mutateBody) body = JSON.stringify(mutateBody(JSON.parse(body)));
    const req = Readable.from([Buffer.from(body ?? '')]);
    let status = 0;
    let out = '';
    const res = { writeHead(s) { status = s; }, end(b) { out = b; } };
    await handler(req, res);
    return { status, json: async () => JSON.parse(out) };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(cwd, { recursive: true, force: true });
});

const prd = (slug, extra = {}) => ({
  title: `T ${slug}`, slug, goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n',
  gate: ['none'], files: ['a.txt'], cwd, ...extra,
});
const callBatch = (prds) => handleCallTool({ params: { name: 'scheduler_create_prds', arguments: { prds } } });
const callOne = (args) => handleCallTool({ params: { name: 'scheduler_create_prd', arguments: args } });
const textOf = (r) => r.content[0].text;
const errOf = (r) => (r.isError ? textOf(r) : '');
const written = () => fs.readdirSync(outDir).sort();
const read = (f) => fs.readFileSync(path.join(outDir, f), 'utf8');
const preflightLine = (text) => (text.match(/^preflight: .*$/m) || [null])[0];

const val = (slug, deps) => prd(slug, { agentType: 'validator', dependsOn: deps });
const stamped = (f) => /^planReview: required$/m.test(read(f));

test('3-PRD plan: validator is stamped and the result says so', async () => {
  const r = await callBatch([prd('a'), prd('b'), prd('c'), val('v', ['a', 'b', 'c'])]);
  expect(errOf(r)).toBe('');
  expect(stamped('903-v.md')).toBe(true);
  expect(parsePrdFile(read('903-v.md')).frontmatter.planReview).toBe('required');
  for (const f of ['900-a.md', '901-b.md', '902-c.md']) expect(stamped(f)).toBe(false);
  expect(textOf(r)).toContain('plan held for plan review before dispatch');
});

test('2 independent PRDs: not stamped', async () => {
  const r = await callBatch([prd('a'), prd('b'), val('v', ['a', 'b'])]);
  expect(r.isError).toBeUndefined();
  expect(stamped('902-v.md')).toBe(false);
  expect(textOf(r)).not.toContain('plan review');
});

test('2-chain: stamped', async () => {
  const r = await callBatch([prd('a'), prd('b', { dependsOn: ['a'] }), val('v', ['b'])]);
  expect(r.isError).toBeUndefined();
  expect(stamped('902-v.md')).toBe(true);
});

test('SM_PLAN_REVIEW=0: nothing stamped', async () => {
  process.env.SM_PLAN_REVIEW = '0';
  const r = await callBatch([prd('a'), prd('b'), prd('c'), val('v', ['a', 'b', 'c'])]);
  expect(r.isError).toBeUndefined();
  for (const f of written()) expect(stamped(f)).toBe(false);
  expect(textOf(r)).not.toContain('plan held for plan review');
});
