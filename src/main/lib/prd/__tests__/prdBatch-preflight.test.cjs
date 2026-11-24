/**
 * prdBatch-preflight.test.cjs — scheduler_create_prds keeps `preflight` end to
 * end: MCP tool input → handleCallTool → (stubbed fetch) → the REAL
 * /admin/scheduler/create-prds route (schema parse + createPrdBatch) → the
 * written PRD file. Valid, invalid and absent preflight, plus the incident
 * shape (PRD 3805, 2026-11-23): a running app that predates preflight drops
 * the key silently, so the batch must be refused, never written without it.
 *
 * Run: timeout 120 npx vitest run src/main/lib/prd/__tests__/prdBatch-preflight.test.cjs
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

const ENV_KEYS = ['SM_ADMIN_TOKEN_PATH', 'SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MAY_QUEUE', 'SM_CHAT_SESSION_ID', 'SM_PROJECT_ROOT'];
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
  cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-batch-preflight-'));
  outDir = path.join(cwd, 'out');
  await fsp.mkdir(outDir, { recursive: true });
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
const written = () => fs.readdirSync(outDir).sort();
const read = (f) => fs.readFileSync(path.join(outDir, f), 'utf8');
const preflightLine = (text) => (text.match(/^preflight: .*$/m) || [null])[0];

// The 3805 incident's own preflight (single quotes keep the parens literal).
const PREFLIGHT = 'node -e \'process.exit(Date.now() >= Date.parse("2026-12-02T00:00:00-08:00") ? 0 : 1)\'';

test('valid preflight on a batch entry is written to that PRD, identical to scheduler_create_prd', async () => {
  const r = await callBatch([prd('held', { preflight: `  ${PREFLIGHT}  ` }), prd('free')]);
  expect(r.isError).toBeUndefined();
  expect(written()).toEqual(['900-held.md', '901-free.md']);
  const held = read('900-held.md');
  expect(parsePrdFile(held).frontmatter.preflight).toBe(PREFLIGHT);
  expect(read('901-free.md')).not.toMatch(/^preflight:/m);

  const one = await callOne(prd('held-single', { preflight: `  ${PREFLIGHT}  ` }));
  expect(one.isError).toBeUndefined();
  expect(preflightLine(read('902-held-single.md'))).toBe(preflightLine(held));
  // The app echoes the preflight it recorded, so the caller can see it landed.
  expect(JSON.parse(textOf(one).split(' — ')[0]).preflight).toBe(PREFLIGHT);
});

test('an invalid preflight refuses the whole batch with that entry\'s index, writing nothing', async () => {
  const r = await callBatch([prd('ok-one'), prd('bad', { preflight: 'echo hi | tee x' }), prd('ok-two', { preflight: 'test -f a.txt' })]);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain('[1] bad');
  expect(textOf(r)).toContain('nothing was written');
  expect(textOf(r)).not.toContain('[0]');
  expect(written()).toEqual([]);
  // Refused before any request reaches the app.
  expect(fetches).toBe(0);
});

test('the app route itself refuses an invalid preflight with the entry index (all-or-nothing)', async () => {
  // Skip the MCP-side check by mutating the body after it: the app must still refuse.
  mutateBody = (b) => { b.prds[1].preflight = 'echo hi | tee x'; return b; };
  const r = await callBatch([prd('ok-one'), prd('bad', { preflight: 'test -f a.txt' })]);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain('[1] bad');
  expect(written()).toEqual([]);
});

test('absent preflight writes no key, even when the app reports no version', async () => {
  writeAdminConfig({});
  const r = await callBatch([prd('plain'), prd('blank', { preflight: '' })]);
  expect(r.isError).toBeUndefined();
  expect(written()).toEqual(['900-plain.md', '901-blank.md']);
  for (const f of written()) expect(read(f)).not.toMatch(/^preflight:/m);
});

test('a running app that predates preflight refuses the batch instead of dropping it silently', async () => {
  for (const appVersion of ['0.140.0', undefined]) {
    writeAdminConfig(appVersion ? { appVersion } : {});
    const r = await callBatch([prd('plain'), prd('held', { preflight: PREFLIGHT })]);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('[1] held');
    expect(textOf(r)).toMatch(/preflight/);
    expect(textOf(r)).toContain(appVersion ? `v${appVersion}` : 'version not reported');
  }
  const one = await callOne(prd('held-single', { preflight: PREFLIGHT }));
  expect(one.isError).toBe(true);
  expect(written()).toEqual([]);
  expect(fetches).toBe(0);
});

test('an app that writes a batch PRD without its preflight is reported loudly, naming the PRD', async () => {
  // Simulates an app whose schema strips the key (the 3805 incident shape).
  mutateBody = (b) => { for (const p of b.prds) delete p.preflight; return b; };
  const r = await callBatch([prd('plain'), prd('held', { preflight: PREFLIGHT })]);
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain('901-held');
  expect(textOf(r)).toContain('scheduler_update_prd');
  expect(textOf(r)).not.toContain('900-plain');
});
