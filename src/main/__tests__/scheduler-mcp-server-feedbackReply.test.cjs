/**
 * scheduler-mcp-server-feedbackReply.test.cjs — the feedback_reply MCP tool:
 * caller-supplied identity is stripped and replaced from this process's env,
 * a scheduled job is refused before any request, and the result note names
 * the delivery honestly (never that the other project acted).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-mcp-server-feedbackReply.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../scripts/scheduler-mcp-server.cjs');
const ENV_KEYS = ['HOME', 'SM_CHAT_SESSION_ID', 'SM_PROJECT_ROOT', 'SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MCP_TOOLS'];

const tmpDirs = [];
const servers = [];
let savedEnv = null;

afterEach(async () => {
  if (savedEnv) {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    savedEnv = null;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (servers.length) await new Promise((r) => servers.pop().close(r));
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function startFakeAdminServer(body) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests }));
  });
}

async function setup(body, env, { appVersion } = {}) {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-reply-'));
  tmpDirs.push(homeDir);
  const { server, requests } = await startFakeAdminServer(body);
  servers.push(server);
  const tokenPath = path.join(homeDir, '.claude', 'session-manager', 'admin-api.json');
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify({ port: server.address().port, token: 't', ...(appVersion ? { appVersion } : {}) }), 'utf8');
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = homeDir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete require.cache[require.resolve(SERVER_PATH)];
  return { ...require(SERVER_PATH), requests };
}

const BASE = { message: 'Done — fixed in abc123.', outcome: 'done' };
const call = (h, args) => h({ params: { name: 'feedback_reply', arguments: args } });

test('feedback_reply is a live MCP tool with the reply contract schema', async () => {
  const { TOOLS } = await setup({ ok: true }, {});
  const tool = TOOLS.find((t) => t.name === 'feedback_reply');
  expect(tool).toBeTruthy();
  expect(tool.inputSchema.required).toEqual(['message', 'outcome']);
  expect(tool.inputSchema.properties.outcome.enum).toEqual(['done', 'blocked', 'question']);
  expect(tool.inputSchema.properties.referencePaths.items.type).toBe('string');
  expect(tool.inputSchema.properties.toEpicId.type).toBe('string');
});

test('strips caller-supplied identity and stamps it from the env', async () => {
  const { handleCallTool, requests } = await setup(
    { ok: true, delivery: 'delivered' },
    { SM_CHAT_SESSION_ID: 'real-sess', SM_PROJECT_ROOT: '/real/root' },
  );
  await call(handleCallTool, {
    ...BASE,
    originClaudeSessionId: 'forged-sess',
    originProjectRoot: '/forged/root',
    fromCwd: '/forged/cwd',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('POST');
  expect(requests[0].url).toBe('/admin/feedback/reply');
  expect(requests[0].body.originClaudeSessionId).toBe('real-sess');
  expect(requests[0].body.originProjectRoot).toBe('/real/root');
  expect(requests[0].body.fromCwd).toBe(process.cwd());
  expect(requests[0].body.message).toBe(BASE.message);
  expect(requests[0].body.outcome).toBe('done');
});

test('with no env identity, forged identity is dropped, not forwarded', async () => {
  const { handleCallTool, requests } = await setup({ ok: false, error: 'no identity' }, {});
  await call(handleCallTool, { ...BASE, originClaudeSessionId: 'forged', originProjectRoot: '/forged' });
  expect(requests[0].body).not.toHaveProperty('originClaudeSessionId');
  expect(requests[0].body).not.toHaveProperty('originProjectRoot');
});

test('refuses inside a scheduled job without making a request', async () => {
  const { handleCallTool, requests } = await setup(
    { ok: true, delivery: 'delivered' },
    { SM_CHAT_SESSION_ID: 'real-sess', SM_SCHEDULER_JOB_SLUG: '42-some-job' },
  );
  const r = await call(handleCallTool, BASE);
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/refused/);
  expect(r.content[0].text).toMatch(/result/);
  expect(requests).toHaveLength(0);
});

test.each([
  ['delivered', 'delivered into the asking session'],
  ['event-only', 'delivered as an event only'],
  ['fallback', 'fell back to a new proposed session'],
])('delivery %s gets an honest note', async (delivery, phrase) => {
  const { handleCallTool } = await setup({ ok: true, delivery }, { SM_CHAT_SESSION_ID: 's' });
  const r = await call(handleCallTool, BASE);
  expect(r.content[0].text).toContain(phrase);
  expect(r.content[0].text).not.toMatch(/fixed it|has acted|is working on it/i);
});

test('event-only delivery the asker requested says it was recorded as an event for the asking app, no chat prompted', async () => {
  const { handleCallTool } = await setup({ ok: true, delivery: 'event-only', reason: 'asker-requested-event' }, { SM_CHAT_SESSION_ID: 's' });
  const r = await call(handleCallTool, BASE);
  const text = r.content[0].text;
  expect(text).toContain('recorded as an event for the asking app');
  expect(text).toContain('no chat was prompted');
  expect(text).not.toContain('delivered as an event only on the asking Epic');
});

test('catalog documents feedback_reply and drops the "no reply channel" wording', () => {
  const { MCP_TOOL_CATALOG, MCP_RECIPES, composeDescription } = require('../lib/mcpToolCatalog.cjs');
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_reply');
  expect(entry.group).toBe('feedback');
  const text = composeDescription(entry);
  expect(text).toMatch(/feedback_open_session/);
  expect(text).toMatch(/Epic that asked/);
  expect(text).toMatch(/refused/);
  expect(text).toMatch(/3 replies per thread/);
  expect(text).toMatch(/verified/);
  const open = composeDescription(MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_open_session'));
  expect(open).not.toMatch(/no reply channel|no callback/i);
  expect(open).toContain('feedback_reply');
  const handOff = MCP_RECIPES.find((r) => r.id === 'hand-finding-to-another-project').steps.join(' ');
  expect(handOff).not.toMatch(/no reply channel|no callback/i);
  expect(handOff).toContain('feedback_reply');
  expect(MCP_RECIPES.find((r) => r.id === 'reply-to-the-project-that-asked').steps.length).toBeGreaterThan(0);
});

// feedback_open_session: the MCP note promises a feedback_reply thread only
// when the server says one was stamped (result.replyThread === true).
const REPLY_SENTENCE = 'The receiving session can answer into this Epic with feedback_reply.';
const NO_REPLY_SENTENCE = ' No reply path: Session Manager could not identify the sending session, so no answer will come back here; ask the human to follow up.';
const OPEN_ARGS = { toCwd: '/p/to', fromCwd: '/p/from', title: 't', body: 'b' };
const openCall = (h) => h({ params: { name: 'feedback_open_session', arguments: OPEN_ARGS } });

test.each([
  ['auto-approved', true],
  ['auto-approved', false],
  ['auto-approved', undefined],
  ['proposed', true],
  ['proposed', false],
  ['proposed', undefined],
])('feedback_open_session %s with replyThread %s gets a truthful reply note', async (status, replyThread) => {
  const body = { ok: true, status, epicId: 'e1' };
  if (replyThread !== undefined) body.replyThread = replyThread;
  const { handleCallTool } = await setup(body, {});
  const text = (await openCall(handleCallTool)).content[0].text;
  if (replyThread === true) {
    expect(text).toContain(REPLY_SENTENCE);
    expect(text).not.toContain(NO_REPLY_SENTENCE);
  } else {
    expect(text).not.toContain('can answer into this Epic with feedback_reply');
    expect(text).toContain(NO_REPLY_SENTENCE);
  }
  expect(text).toContain(status === 'auto-approved' ? 'auto-approved and is starting' : 'PROPOSED session');
});

test('feedback_open_session catalog limits the feedback_reply promise to an identified Epic chat session', () => {
  const { MCP_TOOL_CATALOG, composeDescription } = require('../lib/mcpToolCatalog.cjs');
  const open = composeDescription(MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_open_session'));
  expect(open).toMatch(/only when the call comes from a Session Manager Epic chat session that Session Manager can identify/);
});

// deliverWhen (held replies) arrived in v0.142.0; an older app ignores it and
// delivers at once with {version} unfilled, spending a reply slot.
const HELD = { ...BASE, deliverWhen: { appVersionAbove: '0.141.0' } };

test.each([
  ['0.141.0', 'v0.141.0'],
  [undefined, 'version not reported'],
])('deliverWhen on app %s is refused before any request', async (appVersion, named) => {
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'scheduled' }, { SM_CHAT_SESSION_ID: 's' }, { appVersion });
  const r = await call(handleCallTool, HELD);
  expect(r.isError).toBe(true);
  const text = r.content[0].text;
  expect(text).toContain(named);
  expect(text).toMatch(/at once/);
  expect(text).toContain('{version}');
  expect(text).toMatch(/spend/);
  expect(text).toContain('v0.142.0 or later');
  expect(text).toMatch(/without deliverWhen/);
  expect(requests).toHaveLength(0);
});

test('deliverWhen on app 0.142.0 is sent with deliverWhen', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'scheduled' }, { SM_CHAT_SESSION_ID: 's' }, { appVersion: '0.142.0' });
  const r = await call(handleCallTool, HELD);
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.deliverWhen).toEqual({ appVersionAbove: '0.141.0' });
  expect(r.content[0].text).not.toMatch(/instead of holding/);
});

test('no deliverWhen on app 0.141.0 is sent as before', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'delivered' }, { SM_CHAT_SESSION_ID: 's' }, { appVersion: '0.141.0' });
  const r = await call(handleCallTool, BASE);
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].body).not.toHaveProperty('deliverWhen');
  expect(r.content[0].text).not.toMatch(/instead of holding/);
});

test('a held request the app delivered at once is flagged', async () => {
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'delivered' }, { SM_CHAT_SESSION_ID: 's' }, { appVersion: '0.142.0' });
  const r = await call(handleCallTool, HELD);
  expect(requests).toHaveLength(1);
  const text = r.content[0].text;
  expect(text).toMatch(/delivered the reply immediately instead of holding it/);
  expect(text).toContain("'delivered'");
});

test('catalog says deliverWhen needs v0.142.0 or later; summary unchanged', () => {
  const { MCP_TOOL_CATALOG, composeDescription } = require('../lib/mcpToolCatalog.cjs');
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_reply');
  expect(composeDescription(entry)).toMatch(/deliverWhen needs Session Manager v0\.142\.0 or later running/);
  expect(entry.summary).toBe('Answer the project that sent this session its feedback.');
});

// Release claims: the MCP server (run from the main checkout) applies the
// replyClaims rules itself, so they hold even on an older published app.
const { execFileSync } = require('node:child_process');

async function makeSmRepo(version, { extraCommit = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-reply-repo-'));
  tmpDirs.push(dir);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-code-session-manager', version }));
  git('add', 'package.json');
  git('commit', '-q', '-m', 'init');
  const inside = git('rev-parse', 'HEAD');
  git('tag', `v${version}`);
  let outside = null;
  if (extraCommit) {
    await fsp.writeFile(path.join(dir, 'later.txt'), 'x');
    git('add', 'later.txt');
    git('commit', '-q', '-m', 'later');
    outside = git('rev-parse', 'HEAD');
  }
  return { dir, inside, outside };
}

async function makeOtherRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-reply-other-'));
  tmpDirs.push(dir);
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'some-other-project' }));
  return dir;
}

test('feedback_reply schema declares release { commits } as a closed object', async () => {
  const { TOOLS } = await setup({ ok: true }, {});
  const rel = TOOLS.find((t) => t.name === 'feedback_reply').inputSchema.properties.release;
  expect(rel.type).toBe('object');
  expect(rel.required).toEqual(['commits']);
  expect(rel.additionalProperties).toBe(false);
  expect(rel.properties.commits).toEqual(expect.objectContaining({ type: 'array', items: { type: 'string' } }));
  expect(rel.description).toMatch(/running Session Manager release/);
});

test.each([
  ['{{appVersion}}', {}],
  ['{version}', {}],
  ['<semver>', { deliverWhen: { appVersionAbove: '0.142.0' } }],
])('an unfilled placeholder %s is refused before any request', async (tok, extra) => {
  const root = await makeOtherRepo();
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'delivered' }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: root }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, { message: `Shipped in ${tok}.`, outcome: 'blocked', ...extra });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:/);
  expect(r.content[0].text).toContain(tok);
  expect(requests).toHaveLength(0);
});

test('{version} is allowed in a held reply from a non-Session-Manager repo', async () => {
  const root = await makeOtherRepo();
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'scheduled' }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: root }, { appVersion: '0.142.0' });
  const r = await call(handleCallTool, { message: 'Live in {version}.', outcome: 'done', deliverWhen: { appVersionAbove: '0.142.0' } });
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
});

test.each([
  [{ commits: [] }],
  [{ commits: ['not-a-hash'] }],
  [{ commits: ['abcdef1'], extra: 1 }],
  [['abcdef1']],
])('a malformed release %j is refused before any request', async (release) => {
  const { dir } = await makeSmRepo('0.143.0');
  const { handleCallTool, requests } = await setup({ ok: true }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, { message: 'Live in {version}.', outcome: 'done', release });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:.*release/);
  expect(requests).toHaveLength(0);
});

test('release from a project that is not Session Manager is refused', async () => {
  const root = await makeOtherRepo();
  const { handleCallTool, requests } = await setup({ ok: true }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: root }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, { message: 'Live in {version}.', outcome: 'done', release: { commits: ['abcdef1'] } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:/);
  expect(r.content[0].text).toMatch(/not the Session Manager repo/);
  expect(requests).toHaveLength(0);
});

test.each([
  ['Fixed in Session Manager 0.143.0.', {}],
  ['Live in {version}.', { deliverWhen: { appVersionAbove: '0.142.0' } }],
])('a Session Manager done reply %s without release is refused', async (message, extra) => {
  const { dir } = await makeSmRepo('0.143.0');
  const { handleCallTool, requests } = await setup({ ok: true }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, { message, outcome: 'done', ...extra });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:/);
  expect(r.content[0].text).toContain('release.commits');
  expect(requests).toHaveLength(0);
});

test('a held reply with release is refused on app 0.142.0', async () => {
  const { dir, inside } = await makeSmRepo('0.142.0');
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'scheduled' }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.142.0' });
  const r = await call(handleCallTool, {
    message: 'Live in {version}.', outcome: 'done', deliverWhen: { appVersionAbove: '0.142.0' }, release: { commits: [inside] },
  });
  expect(r.isError).toBe(true);
  const text = r.content[0].text;
  expect(text).toMatch(/^refused:/);
  expect(text).toMatch(/holds replies by version only/);
  expect(text).toMatch(/send it live with release\.commits once the release that contains them runs/i);
  expect(requests).toHaveLength(0);
});

test('a held reply with release is sent on an app above 0.142.0', async () => {
  const { dir, inside } = await makeSmRepo('0.143.0');
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'scheduled' }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, {
    message: 'Live in {version}.', outcome: 'done', deliverWhen: { appVersionAbove: '0.143.0' }, release: { commits: [inside] },
  });
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.message).toBe('Live in {version}.');
  expect(requests[0].body.release).toEqual({ commits: [inside] });
});

test('a live release reply with no running app version is refused', async () => {
  const { dir, inside } = await makeSmRepo('0.143.0');
  const { handleCallTool, requests } = await setup({ ok: true }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir });
  const r = await call(handleCallTool, { message: 'Live in {version}.', outcome: 'done', release: { commits: [inside] } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:.*version/);
  expect(requests).toHaveLength(0);
});

test('a live release reply whose commit is not in the running release is refused', async () => {
  const { dir, outside } = await makeSmRepo('0.143.0', { extraCommit: true });
  const { handleCallTool, requests } = await setup({ ok: true }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, { message: 'Live in {version}.', outcome: 'done', release: { commits: [outside] } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:/);
  expect(r.content[0].text).toContain('does not contain commit');
  expect(requests).toHaveLength(0);
});

test('a live release reply whose tag is missing is refused', async () => {
  const { dir, inside } = await makeSmRepo('0.143.0');
  const { handleCallTool, requests } = await setup({ ok: true }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.144.0' });
  const r = await call(handleCallTool, { message: 'Live in {version}.', outcome: 'done', release: { commits: [inside] } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:.*v0\.144\.0/);
  expect(requests).toHaveLength(0);
});

test('a live release reply naming another Session Manager version is refused', async () => {
  const { dir, inside } = await makeSmRepo('0.143.0');
  const { handleCallTool, requests } = await setup({ ok: true }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, { message: 'Fixed in Session Manager 0.144.0.', outcome: 'done', release: { commits: [inside] } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^refused:/);
  expect(r.content[0].text).toContain('0.144.0');
  expect(requests).toHaveLength(0);
});

test('a verified live release reply is forwarded with {version} filled by the running version', async () => {
  const { dir, inside } = await makeSmRepo('0.143.0');
  const { handleCallTool, requests } = await setup({ ok: true, delivery: 'delivered' }, { SM_CHAT_SESSION_ID: 's', SM_PROJECT_ROOT: dir }, { appVersion: '0.143.0' });
  const r = await call(handleCallTool, {
    message: 'Live in Session Manager {version} ({version}).', outcome: 'done', release: { commits: [inside.slice(0, 10)] },
  });
  expect(r.isError).toBeFalsy();
  expect(requests).toHaveLength(1);
  expect(requests[0].body.message).toBe('Live in Session Manager 0.143.0 (0.143.0).');
  expect(requests[0].body.release).toEqual({ commits: [inside.slice(0, 10)] });
});
