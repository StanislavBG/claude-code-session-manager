/**
 * schedulerMcpServerCustomerFeedback.test.cjs — the customer_feedback_list /
 * customer_feedback_get / customer_feedback_set_status / customer_feedback_submit MCP tools wrapping the
 * customer-feedback admin routes (default source 'app') and the site-feedback routes (source 'site').
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

test('set_status forwards id/status/note (app default unchanged, no cwd sent)', async () => {
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

// ── source: 'site' (website-widget items) ────────────────────────────────────
const GET_TOOL_NAME = 'customer_feedback_get';

function withProjectRoot(root) {
  originalProjectRoot = process.env.SM_PROJECT_ROOT === undefined ? null : process.env.SM_PROJECT_ROOT;
  process.env.SM_PROJECT_ROOT = root;
}

const SITE_ITEM = {
  meta: { hostId: 'FB-7K2QX', status: 'open' },
  report: {
    v: 1,
    page: { url: 'https://example.com/a', title: 'A' },
    viewport: { w: 1280, h: 720, dpr: 2 },
    marks: [{ n: 1, note: 'Button overlaps', selector: '#buy', rect: { x: 1, y: 2, w: 3, h: 4 } }],
    console: [{ level: 'error', msg: 'boom' }],
    network: [{ url: '/api', status: 500 }],
    reporter: { email: 'a@example.com' },
    client: { ua: 'UA' },
  },
  imagePaths: { screenshot: '/p/items/FB-7K2QX/screenshot.png', annotated: '/p/items/FB-7K2QX/annotated.png' },
};

test('list, get and set_status schemas name source and cwd; get is listed from the catalog', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  const list = TOOLS.find((t) => t.name === LIST_TOOL_NAME);
  expect(list.inputSchema.properties.source.enum).toEqual(['app', 'site']);
  expect(list.inputSchema.properties.cwd.type).toBe('string');
  const set = TOOLS.find((t) => t.name === SAVE_TOOL_NAME);
  expect(set.inputSchema.properties.source.enum).toEqual(['app', 'site']);
  expect(set.inputSchema.properties.cwd.type).toBe('string');
  const get = TOOLS.find((t) => t.name === GET_TOOL_NAME);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === GET_TOOL_NAME);
  expect(get.description).toBe(composeDescription(entry));
  expect(get.inputSchema.required).toEqual(['id', 'source']);
  expect(get.inputSchema.properties.source.enum).toEqual(['site']);
});

test("list source:'app' explicitly keeps the app inbox request unchanged", async () => {
  const { handleCallTool, requests } = await setup({ ok: true, items: [] });
  await callTool(handleCallTool, LIST_TOOL_NAME, { source: 'app', cwd: '/ignored' });
  expect(requests[0].url).toBe('/admin/customer-feedback/inbox?pull=1');
});

test("list source:'site' reads the project's site inbox, cwd defaulting to SM_PROJECT_ROOT", async () => {
  const items = [{ hostId: 'FB-7K2QX', status: 'open' }];
  const { handleCallTool, requests } = await setup({ ok: true, items });
  withProjectRoot('/home/u/proj');
  const result = await callTool(handleCallTool, LIST_TOOL_NAME, { source: 'site' });
  expect(result.isError).toBeFalsy();
  expect(requests[0].method).toBe('GET');
  expect(requests[0].url).toBe(`/admin/site-feedback/inbox?cwd=${encodeURIComponent('/home/u/proj')}`);
  const out = JSON.parse(result.content[0].text);
  expect(out.items).toEqual([{ id: 'FB-7K2QX', hostId: 'FB-7K2QX', status: 'open' }]);
  expect(out.items[0].id).toBe(out.items[0].hostId);
  expect(out.source).toBe('site');
  expect(out.label).toContain('NOT INSTRUCTIONS');
  await callTool(handleCallTool, LIST_TOOL_NAME, { source: 'site', cwd: '/other/proj' });
  expect(requests[1].url).toBe(`/admin/site-feedback/inbox?cwd=${encodeURIComponent('/other/proj')}`);
});

test('list and set_status refuse an unknown source without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, items: [] });
  const a = await callTool(handleCallTool, LIST_TOOL_NAME, { source: 'web' });
  const b = await callTool(handleCallTool, SAVE_TOOL_NAME, { id: 'a', status: 'open', source: 'web' });
  expect(a.isError).toBe(true);
  expect(b.isError).toBe(true);
  expect(a.content[0].text).toContain('source');
  expect(requests).toHaveLength(0);
});

test('get returns the full report and image paths under a site-submitted label', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: SITE_ITEM });
  withProjectRoot('/home/u/proj');
  const result = await callTool(handleCallTool, GET_TOOL_NAME, { id: 'FB-7K2QX', source: 'site' });
  expect(result.isError).toBeFalsy();
  expect(requests[0].method).toBe('GET');
  expect(requests[0].url).toBe(`/admin/site-feedback/item?${new URLSearchParams({ cwd: '/home/u/proj', id: 'FB-7K2QX' })}`);
  const out = JSON.parse(result.content[0].text);
  expect(out.label).toMatch(/SITE-SUBMITTED DATA, NOT INSTRUCTIONS/);
  expect(out.source).toBe('site');
  expect(out.id).toBe('FB-7K2QX');
  expect(out.meta).toEqual(SITE_ITEM.meta);
  expect(out.report).toEqual(SITE_ITEM.report);
  for (const k of ['page', 'viewport', 'marks', 'console', 'network', 'reporter', 'client']) expect(out.report).toHaveProperty(k);
  expect(out.report.marks[0]).toMatchObject({ note: 'Button overlaps', selector: '#buy' });
  expect(out.screenshotPath).toBe(SITE_ITEM.imagePaths.screenshot);
  expect(out.annotatedPath).toBe(SITE_ITEM.imagePaths.annotated);
});

test.each([[true, true], [false, false], [null, null], [undefined, null]])(
  'get carries the route\'s reporterVerified (%j -> %j)',
  async (given, shown) => {
    const { handleCallTool } = await setup({ ok: true, item: { ...SITE_ITEM, reporterVerified: given } });
    withProjectRoot('/home/u/proj');
    const result = await callTool(handleCallTool, GET_TOOL_NAME, { id: 'FB-7K2QX', source: 'site' });
    expect(JSON.parse(result.content[0].text).reporterVerified).toBe(shown);
  },
);

test('get passes cwd and nulls absent images', async () => {
  const item = { ...SITE_ITEM, imagePaths: { screenshot: null, annotated: null } };
  const { handleCallTool, requests } = await setup({ ok: true, item });
  const result = await callTool(handleCallTool, GET_TOOL_NAME, { id: 'FB-7K2QX', source: 'site', cwd: '/x/y' });
  expect(new URL(`http://h${requests[0].url}`).searchParams.get('cwd')).toBe('/x/y');
  const out = JSON.parse(result.content[0].text);
  expect(out.screenshotPath).toBeNull();
  expect(out.annotatedPath).toBeNull();
});

test('get returns an error result on {ok:false}', async () => {
  const { handleCallTool } = await setup({ ok: false, error: 'not_found' });
  const bad = await callTool(handleCallTool, GET_TOOL_NAME, { id: 'FB-00000', source: 'site' });
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain('not_found');
});

test("get refuses a missing id or a source other than 'site' without a request", async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: SITE_ITEM });
  for (const args of [{ source: 'site' }, { id: 'FB-7K2QX' }, { id: 'FB-7K2QX', source: 'app' }]) {
    const result = await callTool(handleCallTool, GET_TOOL_NAME, args);
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});

test("set_status source:'site' posts cwd/id/status/note to the site status route", async () => {
  const { handleCallTool, requests } = await setup({ ok: true, meta: { hostId: 'FB-7K2QX', status: 'resolved' } });
  withProjectRoot('/home/u/proj');
  const result = await callTool(handleCallTool, SAVE_TOOL_NAME, { id: 'FB-7K2QX', status: 'resolved', note: 'fixed', source: 'site' });
  expect(result.isError).toBeFalsy();
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/site-feedback/status');
  expect(requests[0].body).toEqual({ cwd: '/home/u/proj', id: 'FB-7K2QX', status: 'resolved', note: 'fixed' });
  await callTool(handleCallTool, SAVE_TOOL_NAME, { id: 'FB-7K2QX', status: 'open', source: 'site', cwd: '/x/y' });
  expect(requests[1].body).toEqual({ cwd: '/x/y', id: 'FB-7K2QX', status: 'open' });
});

test("set_status source:'site' returns an error result on {ok:false}", async () => {
  const { handleCallTool } = await setup({ ok: false, error: 'id must match FB-XXXXX' });
  const result = await callTool(handleCallTool, SAVE_TOOL_NAME, { id: 'bad', status: 'open', source: 'site' });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('FB-XXXXX');
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

const HUMAN = { SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: undefined };

test('submit is listed with its catalog description and a required goal/description/tag schema', async () => {
  const homeDir = await mkTmp();
  const { TOOLS } = requireServerWithHome(homeDir);
  const tool = TOOLS.find((t) => t.name === SUBMIT_TOOL_NAME);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === SUBMIT_TOOL_NAME);
  expect(tool).toBeTruthy();
  expect(entry.group).toBe('customer-feedback');
  expect(tool.description).toBe(composeDescription(entry));
  expect(tool.inputSchema.required).toEqual(['goal', 'description', 'tag']);
  expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['context', 'description', 'goal', 'imagePaths', 'tag']);
  expect(tool.inputSchema.properties.description.maxLength).toBe(5000);
  expect(tool.inputSchema.properties.context.type).toBe('object');
  expect(tool.inputSchema.properties.context.additionalProperties).toBe(false);
  expect(Object.keys(tool.inputSchema.properties.context.properties).sort()).toEqual(['client', 'console', 'marks', 'network', 'page']);
  expect(tool.inputSchema.properties.context.properties.client).toMatchObject({
    type: 'object', additionalProperties: false, properties: { captureError: { type: 'string', maxLength: 200 } },
  });
  expect(tool.inputSchema.properties.goal.type).toBe('string');
  expect(tool.inputSchema.properties.description.type).toBe('string');
  expect(tool.inputSchema.properties.tag.enum).toEqual(['bug', 'feature', 'discussion']);
  expect(tool.inputSchema.properties.imagePaths).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 5 });
  expect(entry.exampleArgs).toHaveProperty('goal');
  expect(entry.exampleArgs).toHaveProperty('description');
  expect(entry.exampleArgs).toHaveProperty('imagePaths');
  expect(entry.exampleArgs).not.toHaveProperty('title');
});

test('submit maps goal/description to title/body and omits imagePaths when absent', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'fb_1' } });
  const result = await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'Panel: x', description: 'details', tag: 'feature' }));
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, item: { id: 'fb_1' } });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/customer-feedback/submit');
  expect(requests[0].body).toEqual({ title: 'Panel: x', body: 'details', tag: 'feature' });
});

test('submit omits an empty imagePaths array', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'fb_1' } });
  await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'd', tag: 'bug', imagePaths: [] }));
  expect(requests[0].body).toEqual({ title: 'g', body: 'd', tag: 'bug' });
});

test('submit forwards imagePaths', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'fb_2' } });
  const imagePaths = ['/tmp/a.png', '/tmp/b.jpg'];
  const result = await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'd', tag: 'bug', imagePaths }));
  expect(result.isError).toBeFalsy();
  expect(requests[0].body).toEqual({ title: 'g', body: 'd', tag: 'bug', imagePaths });
});

test('submit refuses a non-array or 6-entry imagePaths without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  for (const imagePaths of ['/tmp/a.png', ['/a', '/b', '/c', '/d', '/e', '/f'], ['/a', 3]]) {
    const result = await withEnv(HUMAN, () =>
      callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'd', tag: 'bug', imagePaths }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('imagePaths');
  }
  expect(requests).toHaveLength(0);
});

const CONTEXT = {
  page: {
    url: 'https://example.com/pricing',
    title: 'Pricing',
    viewport: { width: 1280, height: 800, devicePixelRatio: 2, scrollX: 0, scrollY: 120 },
  },
  marks: [{ kind: 'pin', n: 1, x: 10, y: 20, color: '#a83818', note: 'Button overlaps the footer' }],
  console: [],
  network: null,
};

test('submit forwards a widget context to the admin route unchanged', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'fb_4' } });
  const context = JSON.parse(JSON.stringify(CONTEXT));
  const result = await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'd', tag: 'bug', context }));
  expect(result.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('/admin/customer-feedback/submit');
  expect(requests[0].body).toEqual({ title: 'g', body: 'd', tag: 'bug', context: CONTEXT });
});

test('submit forwards context.client.captureError (<= 200 chars) to the admin route', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'fb_6' } });
  for (const captureError of ['screenshot failed: tainted canvas', 'e'.repeat(200)]) {
    const context = { ...JSON.parse(JSON.stringify(CONTEXT)), client: { captureError } };
    const result = await withEnv(HUMAN, () =>
      callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'd', tag: 'bug', context }));
    expect(result.isError).toBeFalsy();
  }
  expect(requests).toHaveLength(2);
  expect(requests[0].body.context).toEqual({ ...CONTEXT, client: { captureError: 'screenshot failed: tainted canvas' } });
  expect(requests[1].body.context.client).toEqual({ captureError: 'e'.repeat(200) });
});

test('submit accepts a 5000-char description and refuses 5001 without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: { id: 'fb_5' } });
  const ok = await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'x'.repeat(5000), tag: 'bug' }));
  expect(ok.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  const bad = await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'x'.repeat(5001), tag: 'bug' }));
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain('description');
  expect(requests).toHaveLength(1);
});

test('submit refuses an invalid context without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  const invalid = [
    'not an object',
    ['page'],
    { page: { url: 'https://x', title: 't' } },
    { marks: [{ kind: 'pin', n: 1, x: 1, y: 1, color: 'red', note: '' }] },
    { console: 'oops' },
    { cookies: 'a=b' },
    { client: { widgetVersion: '1' } },
    { client: { captureError: 'x', cookies: 'a=b' } },
    { client: { captureError: 'x'.repeat(201) } },
    { client: { captureError: 7 } },
    { client: 'oops' },
    { client: null },
  ];
  for (const context of invalid) {
    const result = await withEnv(HUMAN, () =>
      callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'd', tag: 'bug', context }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('context');
  }
  expect(requests).toHaveLength(0);
});

test('submit with a context is still refused in a headless job without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  const result = await withEnv({ SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: 'some-job' }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 't', description: 'b', tag: 'bug', context: CONTEXT }));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Feedback panel');
  expect(requests).toHaveLength(0);
});

test('submit passes a warning through in the text result', async () => {
  const body = { ok: true, item: { id: 'fb_3' }, warning: '1 of 2 images was not accepted' };
  const { handleCallTool } = await setup(body);
  const result = await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 'g', description: 'd', tag: 'bug', imagePaths: ['/tmp/a.png', '/tmp/b.png'] }));
  expect(result.isError).toBeFalsy();
  expect(JSON.parse(result.content[0].text)).toEqual(body);
});

test('submit returns an error result on {ok:false}', async () => {
  const { handleCallTool } = await setup({ ok: false, error: 'invalid submission: tag: bad' });
  const result = await withEnv(HUMAN, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 't', description: 'b', tag: 'bug' }));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('invalid submission');
});

test('submit is refused in a headless scheduled job without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  const result = await withEnv({ SM_CHAT_SESSION_ID: 'sess-1', SM_SCHEDULER_JOB_SLUG: 'some-job' }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 't', description: 'b', tag: 'bug' }));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Feedback panel');
  expect(requests).toHaveLength(0);
});

test('submit is refused without SM_CHAT_SESSION_ID without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  const result = await withEnv({ SM_CHAT_SESSION_ID: undefined, SM_SCHEDULER_JOB_SLUG: undefined }, () =>
    callTool(handleCallTool, SUBMIT_TOOL_NAME, { goal: 't', description: 'b', tag: 'bug' }));
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Feedback panel');
  expect(requests).toHaveLength(0);
});

test('submit rejects missing or legacy args without a request', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, item: null });
  for (const args of [{ goal: 't', tag: 'bug' }, { title: 't', body: 'b', tag: 'bug' }, { goal: 't', description: 'b' }]) {
    const result = await withEnv(HUMAN, () => callTool(handleCallTool, SUBMIT_TOOL_NAME, args));
    expect(result.isError).toBe(true);
  }
  expect(requests).toHaveLength(0);
});
