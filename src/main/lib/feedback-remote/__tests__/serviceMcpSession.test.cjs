/**
 * serviceMcpSession.test.cjs — the paired-service MCP JSON-RPC handler:
 * initialize / tools/list scoped to the grant, scope refusal before any
 * route call, malformed messages, fromCwd pinning + replyMode default, the
 * opened-Epic ledger (record on ok, epic_get / events_read limited to it), and
 * MCP content/isError result shaping. A fake invoke stands in for the routes.
 *
 * Run: timeout 120 npx vitest run src/main/lib/feedback-remote/__tests__/serviceMcpSession.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const { handleServiceMcp } = require('../serviceMcpSession.cjs');
const { SERVICE_TOOLS } = require('../serviceMcpTools.cjs');
const { SERVICE_TOOL_NAMES } = require('../servicePairings.cjs');

const HOME = '/home/me/Projects/kiln';

const PROJECTS = '/home/me/Projects';

function makeService(scope = [...SERVICE_TOOL_NAMES], projectRoot = PROJECTS) {
  return { serviceId: 'svc-1', name: 'Kiln Service', homeCwd: HOME, scope, projectRoot };
}

/** opened: [[cwd, epicId], ...] — the ledger is keyed by project + id. */
function makeStore(opened = []) {
  const key = (cwd, epicId) => `${cwd}\0${epicId}`;
  const set = new Set(opened.map(([cwd, epicId]) => key(cwd, epicId)));
  const recorded = [];
  return {
    recorded,
    recordOpened: async (serviceId, entry) => { recorded.push({ serviceId, ...entry }); set.add(key(entry.cwd, entry.epicId)); return true; },
    hasOpened: (serviceId, cwd, epicId) => serviceId === 'svc-1' && set.has(key(cwd, epicId)),
  };
}

/** handler(method, path, opts) -> { status, json } */
function makeInvoke(handler = () => ({ status: 200, json: { ok: true } })) {
  const calls = [];
  const invoke = async (method, p, opts) => { calls.push({ method, path: p, ...opts }); return handler(method, p, opts); };
  return { invoke, calls };
}

function call(name, args, id = 7) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function parsed(response) {
  return JSON.parse(response.result.content[0].text);
}

async function run(msg, { scope, opened, handler, projectRoot } = {}) {
  const service = makeService(scope, projectRoot === undefined ? PROJECTS : projectRoot);
  const store = makeStore(opened);
  const { invoke, calls } = makeInvoke(handler);
  const out = await handleServiceMcp(msg, { service, invoke, store });
  return { ...out, calls, store };
}

// ── initialize / tools/list ────────────────────────────────────────────────

test('initialize answers protocolVersion, serverInfo session-manager and capabilities.tools', async () => {
  const { response, audit, calls } = await run({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  expect(response.id).toBe(1);
  expect(response.result.protocolVersion).toBe('2025-06-18');
  expect(response.result.serverInfo.name).toBe('session-manager');
  expect(typeof response.result.serverInfo.version).toBe('string');
  expect(response.result.capabilities.tools).toEqual({});
  expect(audit).toBeNull();
  expect(calls).toHaveLength(0);
});

test('initialize with an unknown protocolVersion answers a supported one', async () => {
  const { response } = await run({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  expect(typeof response.result.protocolVersion).toBe('string');
  expect(response.result.protocolVersion).not.toBe('1999-01-01');
});

test('tools/list returns SERVICE_TOOLS filtered to service.scope', async () => {
  const { response } = await run({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { scope: ['epic_get', 'events_read'] });
  const names = response.result.tools.map((t) => t.name);
  expect(names).toEqual(['epic_get', 'events_read']);
  const epicGet = SERVICE_TOOLS.find((t) => t.name === 'epic_get');
  expect(response.result.tools[0]).toEqual({ name: 'epic_get', description: epicGet.description, inputSchema: epicGet.inputSchema });
  expect(response.result.tools[0].toRequest).toBeUndefined();
});

test('tools/list with the full scope lists every service tool', async () => {
  const { response } = await run({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  expect(response.result.tools.map((t) => t.name)).toEqual(SERVICE_TOOLS.map((t) => t.name));
});

// ── scope refusal / malformed ──────────────────────────────────────────────

test('tools/call outside service.scope is refused without calling invoke', async () => {
  const { response, audit, calls } = await run(call('macro_run', { cwd: HOME, id: 'm1' }), { scope: ['epic_get'] });
  expect(response.error).toBeTruthy();
  expect(typeof response.error.code).toBe('number');
  expect(response.result).toBeUndefined();
  expect(audit).toEqual({ tool: 'macro_run', result: 'refused:scope' });
  expect(calls).toHaveLength(0);
});

test('tools/call of an unknown tool is refused:scope without calling invoke', async () => {
  const { response, audit, calls } = await run(call('scheduler_create_prd', {}));
  expect(response.error).toBeTruthy();
  expect(audit).toEqual({ tool: 'scheduler_create_prd', result: 'refused:scope' });
  expect(calls).toHaveLength(0);
});

test('malformed messages answer -32600', async () => {
  for (const msg of [null, 'x', [], { id: 1, method: 'tools/list' }, { jsonrpc: '1.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) {
    const { response, calls } = await run(msg);
    expect(response.error.code).toBe(-32600);
    expect(calls).toHaveLength(0);
  }
});

test('bad params answer -32602', async () => {
  const cases = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'nope' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42 } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'epic_get', arguments: [1] } },
    call('events_read', { kinds: ['job_transition'] }),
  ];
  for (const msg of cases) {
    const { response, calls } = await run(msg, { opened: [[HOME, 'ps-1']] });
    expect(response.error.code).toBe(-32602);
    expect(calls).toHaveLength(0);
  }
});

test('unknown method answers -32601; a notification gets no response', async () => {
  expect((await run({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).response.error.code).toBe(-32601);
  const note = await run({ jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(note.response).toBeNull();
});

// ── feedback_open_session ──────────────────────────────────────────────────

const OPEN_ARGS = { toCwd: '/home/me/Projects/site', title: 't', motivation: 'm', acceptanceCriteria: ['a'], body: 'b' };

test('feedback_open_session: missing fromCwd -> homeCwd, replyMode defaults to event, epicId recorded', async () => {
  const handler = () => ({ status: 201, json: { ok: true, epicId: 'ps-new', status: 'proposed' } });
  const { response, audit, calls, store } = await run(call('feedback_open_session', OPEN_ARGS), { handler });
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('POST');
  expect(calls[0].path).toBe('/admin/feedback/open-session');
  expect(calls[0].body.fromCwd).toBe(HOME);
  expect(calls[0].body.replyMode).toBe('event');
  expect(store.recorded).toEqual([{ serviceId: 'svc-1', cwd: OPEN_ARGS.toCwd, epicId: 'ps-new', externalRef: undefined }]);
  expect(audit).toEqual({ tool: 'feedback_open_session', result: 'ok' });
  expect(response.result.isError).toBeUndefined();
  expect(parsed(response)).toEqual({ ok: true, epicId: 'ps-new', status: 'proposed' });
});

test('feedback_open_session records toCwd + the answer externalRef, not homeCwd', async () => {
  const handler = () => ({ status: 201, json: { ok: true, epicId: 'ps-new', status: 'proposed', externalRef: 'kiln:7' } });
  const { store } = await run(call('feedback_open_session', { ...OPEN_ARGS, externalRef: ' kiln:7 ' }), { handler });
  expect(store.recorded).toEqual([{ serviceId: 'svc-1', cwd: '/home/me/Projects/site', epicId: 'ps-new', externalRef: 'kiln:7' }]);
});

test('feedback_open_session: an explicit replyMode and matching fromCwd pass through', async () => {
  const { calls } = await run(call('feedback_open_session', { ...OPEN_ARGS, fromCwd: HOME, replyMode: 'prompt' }));
  expect(calls[0].body.fromCwd).toBe(HOME);
  expect(calls[0].body.replyMode).toBe('prompt');
});

test('feedback_open_session: a different fromCwd is refused without calling invoke', async () => {
  const { response, audit, calls, store } = await run(call('feedback_open_session', { ...OPEN_ARGS, fromCwd: '/home/me/Projects/other' }));
  expect(calls).toHaveLength(0);
  expect(store.recorded).toHaveLength(0);
  expect(response.result.isError).toBe(true);
  expect(parsed(response).ok).toBe(false);
  expect(audit).toEqual({ tool: 'feedback_open_session', result: 'refused:fromCwd' });
});

test('feedback_open_session: a non-2xx answer records nothing and is isError', async () => {
  const handler = () => ({ status: 409, json: { ok: false, error: 'externalRef used by another sender' } });
  const { response, audit, store } = await run(call('feedback_open_session', OPEN_ARGS), { handler });
  expect(store.recorded).toHaveLength(0);
  expect(response.result.isError).toBe(true);
  expect(parsed(response).error).toMatch(/externalRef/);
  expect(audit).toEqual({ tool: 'feedback_open_session', result: 'error:409' });
});

// ── macro_run ──────────────────────────────────────────────────────────────

test('macro_run records its epicId on ok', async () => {
  const handler = () => ({ status: 200, json: { ok: true, epicId: 'ps-mac', alreadyRunning: false } });
  const { audit, calls, store } = await run(call('macro_run', { cwd: HOME, id: 'm1' }), { handler });
  expect(calls[0]).toMatchObject({ method: 'POST', path: '/admin/macros/run', body: { cwd: HOME, id: 'm1' } });
  expect(store.recorded).toEqual([{ serviceId: 'svc-1', cwd: HOME, epicId: 'ps-mac', externalRef: undefined }]);
  expect(audit.result).toBe('ok');
});

test('macro_run records nothing when the route refuses', async () => {
  const handler = () => ({ status: 403, json: { ok: false, error: 'macro is not script-startable' } });
  const { response, store } = await run(call('macro_run', { cwd: HOME, id: 'm1' }), { handler });
  expect(store.recorded).toHaveLength(0);
  expect(response.result.isError).toBe(true);
});

// ── epic_get ───────────────────────────────────────────────────────────────

const epicHandler = (epicId) => () => ({ status: 200, json: { ok: true, epic: { epicId, cwd: HOME, state: 'working' } } });

test('epic_get by id of a ledger Epic answers the record', async () => {
  const { response, calls, audit } = await run(call('epic_get', { cwd: HOME, id: 'ps-1' }), { opened: [[HOME, 'ps-1']], handler: epicHandler('ps-1') });
  expect(calls[0]).toMatchObject({ method: 'GET', path: '/admin/epic', query: { cwd: HOME, id: 'ps-1' } });
  expect(parsed(response).epic.epicId).toBe('ps-1');
  expect(response.result.isError).toBeUndefined();
  expect(audit.result).toBe('ok');
});

test('epic_get by id of a non-ledger Epic answers the route not-found shape without calling invoke', async () => {
  const { response, calls, audit } = await run(call('epic_get', { cwd: HOME, id: 'ps-other' }), { opened: [[HOME, 'ps-1']], handler: epicHandler('ps-other') });
  expect(calls).toHaveLength(0);
  expect(response.result.isError).toBe(true);
  expect(parsed(response)).toEqual({ ok: false, error: 'not found' });
  expect(audit.result).toBe('refused:ledger');
});

test('epic_get by id of a ledger id in a DIFFERENT project is refused without calling invoke', async () => {
  const { response, calls, audit } = await run(call('epic_get', { cwd: '/home/me/Projects/other', id: 'ps-1' }), { opened: [[HOME, 'ps-1']], handler: epicHandler('ps-1') });
  expect(calls).toHaveLength(0);
  expect(parsed(response)).toEqual({ ok: false, error: 'not found' });
  expect(audit.result).toBe('refused:ledger');
});

test('epic_get id-only checks the ledger under the returned epic.cwd', async () => {
  const own = await run(call('epic_get', { id: 'ps-1' }), { opened: [[HOME, 'ps-1']], handler: epicHandler('ps-1') });
  expect(own.calls).toHaveLength(1);
  expect(parsed(own.response).epic.epicId).toBe('ps-1');
  expect(own.audit.result).toBe('ok');

  const elsewhere = () => ({ status: 200, json: { ok: true, epic: { epicId: 'ps-1', cwd: '/home/me/Projects/other', state: 'working' } } });
  const other = await run(call('epic_get', { id: 'ps-1' }), { opened: [[HOME, 'ps-1']], handler: elsewhere });
  expect(parsed(other.response)).toEqual({ ok: false, error: 'not found' });
  expect(other.audit.result).toBe('refused:ledger');
});

test('epic_get by externalRef refuses a returned epic whose cwd differs from the ledger entry', async () => {
  const elsewhere = () => ({ status: 200, json: { ok: true, epic: { epicId: 'ps-1', cwd: '/home/me/Projects/other', state: 'working' } } });
  const { response, audit } = await run(call('epic_get', { cwd: HOME, externalRef: 'kiln:1' }), { opened: [[HOME, 'ps-1']], handler: elsewhere });
  expect(parsed(response)).toEqual({ ok: false, error: 'not found' });
  expect(audit.result).toBe('refused:ledger');
});

test('epic_get by externalRef checks the ledger on the returned epic.epicId', async () => {
  const own = await run(call('epic_get', { cwd: HOME, externalRef: 'kiln:1' }), { opened: [[HOME, 'ps-1']], handler: epicHandler('ps-1') });
  expect(own.calls[0].query).toMatchObject({ cwd: HOME, externalRef: 'kiln:1' });
  expect(parsed(own.response).epic.epicId).toBe('ps-1');

  const other = await run(call('epic_get', { cwd: HOME, externalRef: 'kiln:2' }), { opened: [[HOME, 'ps-1']], handler: epicHandler('ps-other') });
  expect(other.calls).toHaveLength(1);
  expect(other.response.result.isError).toBe(true);
  expect(parsed(other.response)).toEqual({ ok: false, error: 'not found' });
});

test('epic_get: a real 404 from the route reads exactly like a ledger refusal', async () => {
  const handler = () => ({ status: 404, json: { ok: false, error: 'not found' } });
  const real = await run(call('epic_get', { cwd: HOME, externalRef: 'nope' }), { handler });
  const refused = await run(call('epic_get', { cwd: HOME, id: 'ps-x' }));
  expect(real.response.result).toEqual(refused.response.result);
});

// ── events_read ────────────────────────────────────────────────────────────

test('events_read drops rows whose Epic is not in the ledger', async () => {
  const events = [
    { at: '1', kind: 'epic_state_changed', cwd: '/p/site', epicId: 'ps-1', from: 'awaiting_approval', to: 'open' },
    { at: '2', kind: 'epic_state_changed', cwd: '/p/site', epicId: 'ps-other', from: 'open', to: 'closed' },
    { at: '3', kind: 'epic_cross_project_reply', cwd: HOME, fromCwd: '/p/site', fromEpicId: 'ps-1' },
    { at: '4', kind: 'epic_cross_project_reply', cwd: HOME, fromCwd: '/p/site', fromEpicId: 'ps-other' },
    { at: '5', kind: 'job_transition', cwd: '/p/site', epicId: 'ps-1' },
  ];
  const handler = () => ({ status: 200, json: { ok: true, events, next: 'c~1', more: false, gap: false } });
  const { response, calls, audit } = await run(
    call('events_read', { after: 'start', kinds: ['epic_state_changed', 'epic_cross_project_reply'], limit: 50 }),
    { opened: [['/p/site', 'ps-1']], handler },
  );
  expect(calls[0]).toMatchObject({ method: 'GET', path: '/admin/events', query: { after: 'start', kinds: 'epic_state_changed,epic_cross_project_reply', limit: '50' } });
  const body = parsed(response);
  expect(body.events.map((e) => e.at)).toEqual(['1', '3']);
  expect(body).toMatchObject({ ok: true, next: 'c~1', more: false, gap: false });
  expect(audit.result).toBe('ok');
});

test('events_read drops rows whose Epic id is in the ledger but under a different project', async () => {
  const events = [
    { at: '1', kind: 'epic_state_changed', cwd: '/p/site', epicId: 'ps-1', from: 'open', to: 'closed' },
    { at: '2', kind: 'epic_state_changed', cwd: '/p/other', epicId: 'ps-1', from: 'open', to: 'closed' },
    { at: '3', kind: 'epic_cross_project_reply', cwd: HOME, fromCwd: '/p/site', fromEpicId: 'ps-1' },
    { at: '4', kind: 'epic_cross_project_reply', cwd: HOME, fromCwd: '/p/other', fromEpicId: 'ps-1' },
    { at: '5', kind: 'epic_cross_project_reply', cwd: '/p/site', fromCwd: HOME, fromEpicId: 'ps-1' },
    { at: '6', kind: 'epic_state_changed', epicId: 'ps-1', from: 'open', to: 'closed' },
  ];
  const handler = () => ({ status: 200, json: { ok: true, events, next: 'c~1', more: false, gap: false } });
  const { response } = await run(call('events_read', { after: 'start' }), { opened: [['/p/site', 'ps-1']], handler });
  expect(parsed(response).events.map((e) => e.at)).toEqual(['1', '3']);
});

test('events_read passes a route error through as isError', async () => {
  const handler = () => ({ status: 400, json: { ok: false, error: 'invalid query' } });
  const { response, audit } = await run(call('events_read', { after: 'bad' }), { handler });
  expect(response.result.isError).toBe(true);
  expect(audit.result).toBe('error:400');
});

// ── result shaping ─────────────────────────────────────────────────────────

test('tool results are MCP text content of the JSON answer; non-2xx sets isError', async () => {
  const ok = await run(call('feedback_list_projects', {}), { handler: () => ({ status: 200, json: { ok: true, targets: [] } }) });
  expect(ok.response.result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ ok: true, targets: [] }) }] });

  const bad = await run(call('macro_list', { cwd: HOME }), { handler: () => ({ status: 500, json: null }) });
  expect(bad.response.result.isError).toBe(true);
  expect(bad.response.result.content[0].type).toBe('text');
  expect(parsed(bad.response)).toEqual({ ok: false, status: 500 });
});

test('an invoke that throws answers a JSON-RPC error with an error:invoke audit', async () => {
  const { response, audit } = await run(call('macro_list', {}), { handler: () => { throw new Error('boom'); } });
  expect(response.error.code).toBe(-32603);
  expect(audit).toMatchObject({ tool: 'macro_list', result: 'error:invoke' });
});

test('lib-layout lists serviceMcpSession under feedback-remote', () => {
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../scripts/lib-layout.json'), 'utf8'));
  expect(layout.serviceMcpSession).toBe('feedback-remote');
});

// ── project_create ─────────────────────────────────────────────────────────

test('project_create pins parentDir to projectRoot and fromCwd to homeCwd', async () => {
  const handler = () => ({ status: 200, json: { ok: true, status: 'created', cwd: `${PROJECTS}/foo` } });
  const { response, audit, calls } = await run(call('project_create', { name: 'foo', externalRef: 'k-1', fromCwd: '/elsewhere' }), { handler });
  expect(audit).toEqual({ tool: 'project_create', result: 'ok' });
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('POST');
  expect(calls[0].path).toBe('/admin/projects/create');
  expect(calls[0].body).toEqual({ name: 'foo', externalRef: 'k-1', parentDir: PROJECTS, fromCwd: HOME });
  expect(parsed(response).ok).toBe(true);
});

test('project_create accepts a parentDir that resolves to projectRoot', async () => {
  const { audit, calls } = await run(call('project_create', { name: 'foo', externalRef: 'k-1', parentDir: `${PROJECTS}/x/../` }));
  expect(audit.result).toBe('ok');
  expect(calls[0].body.parentDir).toBe(PROJECTS);
});

test('project_create refuses a different parentDir without invoking', async () => {
  const { response, audit, calls } = await run(call('project_create', { name: 'foo', externalRef: 'k-1', parentDir: '/tmp' }));
  expect(audit).toEqual({ tool: 'project_create', result: 'refused:parentDir' });
  expect(calls).toHaveLength(0);
  expect(response.result.isError).toBe(true);
  const body = parsed(response);
  expect(body.ok).toBe(false);
  expect(typeof body.error).toBe('string');
  expect(body.projectRoot).toBe(PROJECTS);
});

test('project_create refuses when the pairing has no projectRoot', async () => {
  const { response, audit, calls } = await run(call('project_create', { name: 'foo', externalRef: 'k-1' }), { projectRoot: null });
  expect(audit).toEqual({ tool: 'project_create', result: 'refused:projectRoot' });
  expect(calls).toHaveLength(0);
  expect(response.result.isError).toBe(true);
  expect(parsed(response).ok).toBe(false);
});

test('project_create outside scope answers -32001 and tools/list hides it', async () => {
  const scope = SERVICE_TOOL_NAMES.filter((n) => n !== 'project_create');
  const { response, audit, calls } = await run(call('project_create', { name: 'foo', externalRef: 'k-1' }), { scope });
  expect(response.error.code).toBe(-32001);
  expect(audit).toEqual({ tool: 'project_create', result: 'refused:scope' });
  expect(calls).toHaveLength(0);
  const listed = await run({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { scope });
  expect(listed.response.result.tools.map((t) => t.name)).not.toContain('project_create');
});
