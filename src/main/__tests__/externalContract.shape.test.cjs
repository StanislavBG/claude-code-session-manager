/**
 * externalContract.shape.test.cjs — pins the outside contract.
 *
 * 1. The manifest (CONTRACT) hashes to the fingerprint recorded for the
 *    current CONTRACT_VERSION — a shape change without a version bump fails.
 * 2. The manifest matches the code: routes are registered by their modules,
 *    tools carry exactly the listed required arguments, states/event kinds
 *    equal the code's lists, record/receipt/admin-api.json keys match.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/externalContract.shape.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, afterAll } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { CONTRACT, CONTRACT_VERSION, CONTRACT_FINGERPRINTS, contractFingerprint } = require('../lib/externalContract.cjs');
const { createAdminHttp, TOKEN_PATH } = require('../lib/feedback-remote/localAdminHttp.cjs');

// Never let start() touch the production admin-api.json (see localAdminHttp.test.cjs).
const TEST_TOKEN_PATH = path.join(path.dirname(TOKEN_PATH), `admin-api.contract-test-${process.pid}.json`);
process.env.SM_ADMIN_TOKEN_PATH = TEST_TOKEN_PATH;
afterAll(() => { fs.rmSync(TEST_TOKEN_PATH, { force: true }); });

// ── 1. version ↔ fingerprint ────────────────────────────────────────────────

test('the manifest fingerprint matches the one recorded for CONTRACT_VERSION', () => {
  const actual = contractFingerprint();
  const recorded = CONTRACT_FINGERPRINTS[CONTRACT_VERSION];
  if (actual !== recorded) {
    throw new Error(
      `The outside contract manifest changed (fingerprint ${actual}) but CONTRACT_VERSION ${CONTRACT_VERSION} `
      + `records ${recorded ?? '(nothing)'}. If the change breaks an outside caller, increase CONTRACT_VERSION `
      + `in src/main/lib/externalContract.cjs and record the new fingerprint under CONTRACT_FINGERPRINTS[<new version>].`,
    );
  }
  expect(actual).toMatch(/^[0-9a-f]{64}$/);
});

test('CONTRACT is deeply frozen and the fingerprint is stable', () => {
  const deepFrozen = (v) => v === null || typeof v !== 'object'
    || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
  expect(deepFrozen(CONTRACT)).toBe(true);
  expect(Object.keys(CONTRACT_FINGERPRINTS)).toEqual(['1']);
  expect(contractFingerprint()).toBe(contractFingerprint());
});

// ── 2. manifest ↔ code ──────────────────────────────────────────────────────

function fakeAdminHttp() {
  const routes = [];
  return { routes, registerRoute: (method, p) => { routes.push(`${method} ${p}`); } };
}

function request(port, reqPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: reqPath, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('every listed admin route is registered by its module', async () => {
  const fake = fakeAdminHttp();
  require('../lib/epic/epicAdminRoutes.cjs').registerAdminRoute(fake);
  require('../lib/telemetry/eventsAdminRoutes.cjs').registerAdminRoute(fake);
  require('../lib/feedback-remote/macroAdminRoutes.cjs').registerAdminRoute(fake, { startExternalNewSession: async () => ({}) });
  require('../lib/feedback-remote/crossProjectFeedback.cjs').registerAdminRoute(fake);

  // The health route lives inside localAdminHttp.cjs itself — check it on a real server.
  const admin = createAdminHttp();
  const { port, token } = await admin.start();
  let health;
  let tokenFile;
  try {
    const healthRoute = CONTRACT.routes.find((r) => r.path === '/__admin/health');
    expect(healthRoute).toBeTruthy();
    health = await request(port, healthRoute.path, token);
    tokenFile = JSON.parse(fs.readFileSync(TEST_TOKEN_PATH, 'utf8'));
  } finally {
    await admin.stop();
  }
  expect(health.status).toBe(200);

  for (const r of CONTRACT.routes) {
    if (r.path === '/__admin/health') { expect(r.method).toBe('GET'); continue; }
    expect(fake.routes).toContain(`${r.method} ${r.path}`);
  }
  expect([...Object.keys(tokenFile)].sort()).toEqual([...CONTRACT.adminApiFields].sort());
});

test('every listed MCP tool exists with exactly the listed required arguments', () => {
  const { TOOLS } = require(path.join(__dirname, '../../../scripts/scheduler-mcp-server.cjs'));
  for (const [name, spec] of Object.entries(CONTRACT.tools)) {
    const tool = TOOLS.find((t) => t.name === name);
    expect(tool, `tool ${name}`).toBeTruthy();
    expect([...(tool.inputSchema.required ?? [])].sort(), `tool ${name} required`).toEqual([...spec.required].sort());
  }
});

test("every listed MCP tool's requiredOneOf equals its MCP_TOOL_CATALOG entry (absent on both sides is equal)", () => {
  const { MCP_TOOL_CATALOG } = require('../lib/mcpToolCatalog.cjs');
  for (const [name, spec] of Object.entries(CONTRACT.tools)) {
    const entry = MCP_TOOL_CATALOG.find((t) => t.name === name);
    expect(entry, `catalog entry ${name}`).toBeTruthy();
    expect(entry.requiredOneOf ?? null, `tool ${name} requiredOneOf`).toEqual(spec.requiredOneOf ?? null);
  }
});

test('states and event kinds equal the code lists', () => {
  const { EPIC_OUTSIDE_STATES } = require('../lib/epic/epicOutsideState.cjs');
  const { OUTSIDE_EVENT_KINDS } = require('../lib/telemetry/auditEvents.cjs');
  expect(CONTRACT.epicStates).toEqual([...EPIC_OUTSIDE_STATES]);
  expect(CONTRACT.eventKinds).toEqual([...OUTSIDE_EVENT_KINDS]);
});

// ── record + receipt keys from a real getEpicRecord ─────────────────────────

const tmpDirs = [];
let prevHome;
async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-contract-home-');
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

test('record and receipt field names equal the keys getEpicRecord builds with receipt true', async () => {
  const { getEpicRecord } = require('../lib/epic/epicOutsideRead.cjs');
  const cwd = await mkTmp('sm-contract-cwd-');
  const runsRoot = await mkTmp('sm-contract-runs-');
  const tdir = await mkTmp('sm-contract-tx-');
  const ps = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(ps, { recursive: true });
  fs.writeFileSync(path.join(ps, 'active-index.json'), JSON.stringify({
    sessions: {
      'e-1': {
        id: 'e-1', cwd, goalText: 'Title\n\nGoal.', claudeSessionId: 'sess-e-1', status: 'active',
        tag: 'feature', agentType: 'architect', createdAt: '2026-11-01T00:00:00.000Z',
        source: { producer: 'portfolio', fromCwd: '/elsewhere', fromEpicId: 'e-x', macroId: 'm-1', externalRef: 'ref-1' },
      },
    },
    events: {},
  }));
  const tpath = path.join(tdir, 'sess-e-1.jsonl');
  fs.writeFileSync(tpath, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
  const rec = await getEpicRecord(cwd, {
    id: 'e-1', receipt: true, projectRoots: () => [cwd], listJobs: () => [], runsRoot,
    resolveTranscriptPath: () => ({ path: tpath, candidates: [tpath], existsAnywhere: true, existingPaths: [tpath] }),
  });
  expect(rec).toBeTruthy();
  expect(Object.keys(rec)).toEqual([...CONTRACT.epicRecordFields, 'receipt']);
  expect(Object.keys(rec.receipt)).toEqual([...CONTRACT.receiptFields]);
});

// ── epic_state_changed keys from a real watcher row read back by readEventsAfter ──

test('an epic_state_changed event from the watcher carries only listed keys and always the core ones', async () => {
  const { configureEpicStateWatcher, runEpicStateWatch } = require('../lib/epic/epicStateWatcher.cjs');
  const { readEventsAfter } = require('../lib/telemetry/auditEvents.cjs');
  const cwd = await mkTmp('sm-contract-watch-cwd-');
  const ps = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(ps, { recursive: true });
  const session = (id, extra = {}) => ({
    id, cwd, goalText: `Title ${id}`, claudeSessionId: `sess-${id}`, status: 'active',
    tag: 'feature', agentType: 'architect', createdAt: '2026-11-01T00:00:00.000Z', ...extra,
  });
  const writeIndex = (list) => fs.writeFileSync(path.join(ps, 'active-index.json'), JSON.stringify({
    sessions: Object.fromEntries(list.map((s) => [s.id, s])), events: {},
  }));
  configureEpicStateWatcher({ isTabBusy: () => false, projectRoots: () => [cwd] });
  try {
    writeIndex([session('e-1', { source: { externalRef: 'ref-1' } }), session('e-gone')]);
    await runEpicStateWatch({ cwds: [cwd], jobs: [] }); // seeds silently
    writeIndex([session('e-1', { source: { externalRef: 'ref-1' } }), session('e-new', { createdAt: '2026-11-03T00:00:00.000Z' })]);
    const failed = { epicId: 'e-1', slug: '0001-x', status: 'failed', finishedAt: '2026-11-02T00:00:00.000Z' };
    const changes = await runEpicStateWatch({ cwds: [cwd], jobs: [failed] });
    expect(changes.length).toBe(3);
  } finally {
    configureEpicStateWatcher({ isTabBusy: () => false });
  }

  const { events } = readEventsAfter({ after: 'start', kinds: ['epic_state_changed'] });
  expect(events).toHaveLength(3);
  const allowed = new Set(CONTRACT.epicStateChangedFields);
  const seen = new Set();
  for (const ev of events) {
    for (const k of Object.keys(ev)) { expect(allowed.has(k), `unlisted key ${k}`).toBe(true); seen.add(k); }
    for (const k of ['at', 'kind', 'cwd', 'epicId', 'to']) expect(ev, `required key ${k}`).toHaveProperty(k);
    expect(ev.kind).toBe('epic_state_changed');
  }
  // The rows exercised every listed key at least once.
  expect([...seen].sort()).toEqual([...CONTRACT.epicStateChangedFields].sort());
});
