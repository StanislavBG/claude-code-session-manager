/**
 * telemetryContract.test.cjs — integration test proving the bytes
 * session-manager actually sends are accepted and correctly mapped by the
 * deployed bilko.run ingest contract, that every persisted row is
 * attributable to an app version + machine class, and that the
 * accumulate -> drain -> confirm -> mark-done lifecycle delivers each record
 * EXACTLY ONCE across restarts, evictions and repeated launches.
 *
 * Starts a real node:http server (no fetch injection) that mirrors the
 * validation + INSERT column mapping of ~/Projects/Bilko/server/routes/
 * telemetry.ts, and points telemetryClient at it via SM_TELEMETRY_ENDPOINT.
 * The server MATERIALISES exactly what the deployed route would persist
 * (dropping anything the route does not read) rather than echoing the whole
 * request body back, so a field-name mismatch or a missing-attribution bug
 * cannot pass silently.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/telemetryContract.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const opsErrorLog = require('../lib/opsErrorLog.cjs');
const { isEphemeralCwd } = require('../lib/ephemeralCwd.cjs');
const { resolveProjectContext } = require('../lib/projectRootResolve.cjs');

// ─── transcription of ~/Projects/Bilko/server/routes/telemetry.ts's shape
// rules, read fresh for this PRD. The stub below uses these to materialise
// exactly what each INSERT statement persists — never the raw request body. ─

const MAX_BATCH = 50;
const MAX_FIELD_BYTES = 4000;
const MAX_STACK_BYTES = 16000;
const ALLOWED_LEVELS = new Set(['info', 'warn', 'error']);

function clamp(s, n) {
  return typeof s === 'string' ? s.slice(0, n) : String(s ?? '').slice(0, n);
}

function safeMeta(val, maxBytes) {
  try { return JSON.stringify(val ?? {}).slice(0, maxBytes); } catch { return '{}'; }
}

/** Mirrors telemetry.ts's eventVersion(): top-level e.version, else props.appVersion/version, else NULL. */
function eventVersion(e) {
  const props = e && typeof e.props === 'object' ? e.props : undefined;
  const raw = (e && e.version) ?? props?.appVersion ?? props?.version;
  const v = clamp(raw, 20).trim();
  return v || null;
}

// ─── stub ingest server ─────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * Starts one real HTTP server for the WHOLE test file (see AC: "across the
 * ENTIRE test run"). Persists MATERIALISED rows (never raw request bodies)
 * into events/logs/errors tables, keyed exactly like the three INSERT
 * statements in telemetry.ts, so a field this app transmits but the deployed
 * route never reads (a version mismatch on /event, an un-mapped top-level
 * field) is silently dropped here exactly as it would be in production.
 */
async function createStubServer() {
  const state = {
    events: [], // { event, tool, metadata, session_id, visitor_id, path, version }
    logs: [], // { app, version, level, msg, visitor_id, session_id, fields_json, created_at }
    errors: [], // { app, version, name, msg, stack, url, ua, visitor_id, session_id, context_json, created_at }
    allRequests: [], // { path, headers, rawBody, parsedBody, channel }
    overrides: { event: [], log: [], error: [] },
  };

  function nextOverride(channel) {
    const q = state.overrides[channel];
    return q && q.length ? q.shift() : null;
  }

  const server = http.createServer(async (req, res) => {
    const rawBody = await readBody(req);
    let parsedBody = null;
    try { parsedBody = rawBody ? JSON.parse(rawBody) : {}; } catch { parsedBody = null; }
    const urlPath = (req.url || '').split('?')[0];
    const channel = urlPath.endsWith('/event') ? 'event'
      : urlPath.endsWith('/log') ? 'log'
      : urlPath.endsWith('/error') ? 'error'
      : null;
    state.allRequests.push({ path: urlPath, headers: req.headers, rawBody, parsedBody, channel });

    const override = channel ? nextOverride(channel) : null;
    if (override) {
      res.writeHead(override.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(override.body || { error: 'stubbed' }));
      return;
    }

    if (!channel || !parsedBody) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request' }));
      return;
    }

    const batchRaw = Array.isArray(parsedBody.batch) ? parsedBody.batch : [];
    const batch = batchRaw.slice(0, MAX_BATCH); // MAX_BATCH truncation, exactly as the deployed route does

    if (channel === 'event') {
      let ingested = 0;
      for (const e of batch) {
        if (!e || typeof e !== 'object') continue;
        state.events.push({
          event: clamp(e.name, 80),
          tool: clamp(e.app, 60),
          metadata: safeMeta(e.props, MAX_FIELD_BYTES),
          session_id: clamp(e.session_id, 80),
          visitor_id: clamp(e.visitor_id, 80),
          path: clamp((e.props && typeof e.props === 'object' ? e.props.path : undefined), 200),
          version: eventVersion(e),
        });
        ingested += 1;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ingested }));
      return;
    }

    if (channel === 'log') {
      for (const l of batch) {
        if (!l || typeof l !== 'object') continue;
        if (!ALLOWED_LEVELS.has(String(l.level))) continue; // drop invalid levels silently
        state.logs.push({
          app: clamp(l.app, 60),
          version: clamp(l.version, 20),
          level: String(l.level),
          msg: clamp(l.msg, 500),
          visitor_id: clamp(l.visitor_id, 80),
          session_id: clamp(l.session_id, 80),
          fields_json: safeMeta(l.fields, MAX_FIELD_BYTES),
          created_at: Math.floor((typeof l.ts === 'number' ? l.ts : Date.now()) / 1000),
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // channel === 'error'
    for (const e of batch) {
      if (!e || typeof e !== 'object') continue;
      state.errors.push({
        app: clamp(e.app, 60),
        version: clamp(e.version, 20),
        name: clamp(e.name, 60),
        msg: clamp(e.msg, 500),
        stack: clamp(e.stack, MAX_STACK_BYTES),
        url: clamp(e.url, 500),
        ua: clamp(e.ua, 200),
        visitor_id: clamp(e.visitor_id, 80),
        session_id: clamp(e.session_id, 80),
        context_json: safeMeta(e.context, MAX_FIELD_BYTES),
        created_at: Math.floor((typeof e.ts === 'number' ? e.ts : Date.now()) / 1000),
      });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    queueOverride(channel, status, body) {
      state.overrides[channel].push({ status, body });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ─── attribution recovery helper ────────────────────────────────────────

function jsonFieldFor(table) {
  if (table === 'events') return 'metadata';
  if (table === 'logs') return 'fields_json';
  return 'context_json';
}

function attributionOf(row, table) {
  let parsed = {};
  try { parsed = JSON.parse(row[jsonFieldFor(table)] || '{}'); } catch { parsed = {}; }
  const appVersion = (row.version && row.version.trim()) || (typeof parsed.appVersion === 'string' && parsed.appVersion) || null;
  const machineDigest = (typeof parsed.machineDigest === 'string' && parsed.machineDigest) || null;
  return { appVersion, machineDigest };
}

function recordIdOf(row, table) {
  try {
    const parsed = JSON.parse(row[jsonFieldFor(table)] || '{}');
    return typeof parsed.recordId === 'string' ? parsed.recordId : null;
  } catch {
    return null;
  }
}

// ─── module-reload helpers (mirrors telemetryClient.test.cjs / telemetryBacklog.test.cjs) ───

const tmpDirs = []; // cleaned after each test
const persistentTmpDirs = []; // project dirs holding fixture files — must survive to the FINAL ROLLUP test, cleaned in afterAll
const fixtureSnapshots = []; // { path, mtimeMs, bytes: Buffer } captured right after each fixture write

let originalHome;
let originalSmTelemetry;
let originalSmTelemetryEndpoint;
let originalSmBeaconKey;
let stubServer;

beforeAll(async () => {
  stubServer = await createStubServer();
});

afterAll(async () => {
  if (stubServer) await stubServer.close();
  while (persistentTmpDirs.length) {
    const d = persistentTmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

beforeEach(() => {
  originalHome = process.env.HOME;
  originalSmTelemetry = process.env.SM_TELEMETRY;
  originalSmTelemetryEndpoint = process.env.SM_TELEMETRY_ENDPOINT;
  originalSmBeaconKey = process.env.SM_BEACON_KEY;
  process.env.SM_TELEMETRY_ENDPOINT = stubServer.url;
  delete process.env.SM_TELEMETRY;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome; else delete process.env.HOME;
  if (originalSmTelemetry === undefined) delete process.env.SM_TELEMETRY; else process.env.SM_TELEMETRY = originalSmTelemetry;
  if (originalSmTelemetryEndpoint === undefined) delete process.env.SM_TELEMETRY_ENDPOINT; else process.env.SM_TELEMETRY_ENDPOINT = originalSmTelemetryEndpoint;
  if (originalSmBeaconKey === undefined) delete process.env.SM_BEACON_KEY; else process.env.SM_BEACON_KEY = originalSmBeaconKey;
  vi.useRealTimers();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-telemetry-contract-home-'));
  tmpDirs.push(dir);
  return dir;
}

async function mkProject(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `sm-telemetry-contract-project-${name}-`));
  // Not pushed to tmpDirs: fixture files written under this project must
  // survive to the FINAL ROLLUP test's byte-for-byte/mtime check.
  persistentTmpDirs.push(dir);
  return dir;
}

function fakeProfile(overrides = {}) {
  return {
    appVersion: '0.83.0',
    installChannel: 'dev',
    machineDigest: 'deadbeefcafe',
    platform: 'linux',
    osRelease: '6.1.0',
    arch: 'x64',
    cpuModel: 'Intel(R) Xeon(R) CPU @ 2.20GHz',
    cpuCount: 8,
    cpuSpeedMhz: 2200,
    totalMemMb: 16384,
    nodeVersion: process.versions.node,
    electronVersion: '33.0.0',
    chromeVersion: '130.0.0',
    v8Version: '12.0.0',
    claudeCliVersion: '1.2.3',
    locale: 'en-US',
    timezoneOffsetMinutes: 420,
    firstSeenAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

const HOME_DEPENDENT_MODULES = ['../lib/telemetryClient.cjs', '../config.cjs', '../lib/telemetrySettings.cjs', '../lib/machineProfile.cjs'];

/** A fresh telemetryClient bound to `home`, simulating a real relaunch: only on-disk state carries over. */
function freshClient(home, profileOverrides) {
  process.env.HOME = home;
  for (const p of HOME_DEPENDENT_MODULES) {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  }
  const client = require('../lib/telemetryClient.cjs');
  client._setMachineProfileBuilder(async () => fakeProfile(profileOverrides));
  return client;
}

/** telemetryBoot.cjs is loaded separately since it has its own dep-resolution (not through telemetryClient's profile builder). */
function freshBoot() {
  const resolved = require.resolve('../lib/telemetryBoot.cjs');
  delete require.cache[resolved];
  return require('../lib/telemetryBoot.cjs');
}

function freshBacklog() {
  const resolved = require.resolve('../lib/telemetryBacklog.cjs');
  delete require.cache[resolved];
  return require('../lib/telemetryBacklog.cjs');
}

function makeBacklogDeps({ telemetryClient, config, tabCwds }) {
  return {
    sessionsStore: { load: async () => ({ tabs: tabCwds.map((cwd) => ({ cwd })), activeTabId: null }) },
    isEphemeralCwd,
    resolveProjectContext,
    telemetryClient,
    opsErrorLog,
    config,
    fs,
    fsp,
  };
}

function errLine(i, overrides = {}) {
  return {
    ts: new Date().toISOString(),
    level: 'error',
    scope: `synthetic-${i}`,
    tabId: null,
    epicId: null,
    tags: [`level:error`, `scope:synthetic-${i}`],
    message: `boom ${i}`,
    ...overrides,
  };
}

function recentDateStr(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

function writeErrorsFile(projectCwd, dateStr, lines, { trailingNewline = true } = {}) {
  const dir = opsErrorLog.logsDir(projectCwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `errors-${dateStr}.jsonl`);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, trailingNewline ? body + '\n' : body);
  const stat = fs.statSync(file);
  fixtureSnapshots.push({ path: file, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(file) });
  return file;
}

async function readQueueLines(client) {
  try {
    const raw = await fsp.readFile(client.queuePath(), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AC: real server, no fetch injection, drives the actual client
// ═══════════════════════════════════════════════════════════════════════

test('a real HTTP stub, driven by the actual telemetryClient with no fetch injection, receives materialised rows on all three channels', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const before = { e: stubServer.state.events.length, l: stubServer.state.logs.length, r: stubServer.state.errors.length };

  await client.track('contract.smoke', { a: 1 });
  await client.logLine({ level: 'info', msg: 'smoke log' });
  await client.reportError({ name: 'SmokeError', msg: 'smoke error', stack: 'SmokeError: smoke error\n    at f (a.js:1:1)' });
  await client.flush('manual');

  expect(stubServer.state.events.length).toBe(before.e + 1);
  expect(stubServer.state.logs.length).toBe(before.l + 1);
  expect(stubServer.state.errors.length).toBe(before.r + 1);
  client.shutdown();
});

// ═══════════════════════════════════════════════════════════════════════
// AC: stub mirrors deployed validation — batch cap, allowed levels
// ═══════════════════════════════════════════════════════════════════════

// These two tests probe the stub's raw validation with hand-built (non-client)
// payloads, so they run against a throwaway server instance rather than the
// shared `stubServer` — keeping the FINAL ROLLUP's attribution/PII sweep
// scoped to traffic that actually went through the real client contract.

test('a batch over 50 is truncated to exactly 50 persisted rows, mirroring the deployed route', async () => {
  const scratch = await createStubServer();
  try {
    const batch = Array.from({ length: 75 }, (_, i) => ({
      name: `evt-${i}`, app: 'session-manager', props: { appVersion: '9.9.9' }, session_id: 's', visitor_id: 'v',
    }));
    const res = await fetch(`${scratch.url}/api/telemetry/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ingested).toBe(50);
    expect(scratch.state.events.length).toBe(50);
  } finally {
    await scratch.close();
  }
});

test('log levels outside {info,warn,error} are dropped, valid levels persist', async () => {
  const scratch = await createStubServer();
  try {
    const batch = [
      { app: 'session-manager', version: '1.0.0', level: 'debug', msg: 'nope', visitor_id: 'v', session_id: 's', fields: {} },
      { app: 'session-manager', version: '1.0.0', level: 'info', msg: 'yes', visitor_id: 'v', session_id: 's', fields: {} },
      { app: 'session-manager', version: '1.0.0', level: 'critical', msg: 'nope2', visitor_id: 'v', session_id: 's', fields: {} },
    ];
    await fetch(`${scratch.url}/api/telemetry/log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch }),
    });
    expect(scratch.state.logs.length).toBe(1);
    expect(scratch.state.logs[0].msg).toBe('yes');
  } finally {
    await scratch.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// AC: non-NULL for every column the real route reads
// ═══════════════════════════════════════════════════════════════════════

test('an emitted event, log, and error each map to non-NULL values for every column the real route reads', async () => {
  const home = await mkHome();
  const client = freshClient(home, { appVersion: '1.2.3' });
  const eBefore = stubServer.state.events.length;
  const lBefore = stubServer.state.logs.length;
  const rBefore = stubServer.state.errors.length;

  await client.track('column.check', { a: 1 });
  await client.logLine({ level: 'warn', msg: 'careful' });
  await client.reportError({ name: 'ColumnError', msg: 'boom', stack: 'ColumnError: boom\n    at f (a.js:1:1)' });
  await client.flush('manual');

  const ev = stubServer.state.events[eBefore];
  for (const col of ['event', 'tool', 'metadata', 'session_id', 'visitor_id']) {
    expect(ev[col]).toBeTruthy();
  }

  const lg = stubServer.state.logs[lBefore];
  for (const col of ['app', 'version', 'level', 'msg', 'visitor_id', 'session_id', 'fields_json']) {
    expect(lg[col]).toBeTruthy();
  }
  expect(lg.created_at).not.toBeNull();
  expect(typeof lg.created_at).toBe('number');

  const er = stubServer.state.errors[rBefore];
  for (const col of ['app', 'version', 'name', 'msg', 'stack', 'visitor_id', 'session_id', 'context_json']) {
    expect(er[col]).toBeTruthy();
  }
  expect(er.created_at).not.toBeNull();
  expect(typeof er.created_at).toBe('number');

  client.shutdown();
});

// ═══════════════════════════════════════════════════════════════════════
// AC: machine-profile record survives redaction + clamping intact
// ═══════════════════════════════════════════════════════════════════════

test('the machine-profile record arrives with every buildMachineProfile() field present after redaction/clamping, cpuModel verbatim', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const profile = fakeProfile();
  const before = stubServer.state.events.length;

  await client.track('install.machine', profile);
  await client.flush('manual');

  const row = stubServer.state.events[before];
  expect(row.event).toBe('install.machine');
  const meta = JSON.parse(row.metadata);

  const expectedFields = [
    'appVersion', 'installChannel', 'machineDigest', 'platform', 'osRelease', 'arch',
    'cpuModel', 'cpuCount', 'cpuSpeedMhz', 'totalMemMb', 'nodeVersion', 'electronVersion',
    'chromeVersion', 'v8Version', 'claudeCliVersion', 'locale', 'timezoneOffsetMinutes', 'firstSeenAt',
  ];
  for (const f of expectedFields) {
    expect(meta[f]).not.toBeUndefined();
    expect(meta[f]).not.toBeNull();
  }
  // The over-eager-sanitiser casualty: a CPU model string containing spaces and '@'.
  expect(meta.cpuModel).toBe('Intel(R) Xeon(R) CPU @ 2.20GHz');

  client.shutdown();
});

// ═══════════════════════════════════════════════════════════════════════
// AC: machine profile sent once per version + once per 30-day heartbeat
// ═══════════════════════════════════════════════════════════════════════

test('install.machine fires once per app version and once per 30-day heartbeat, not once per launch', async () => {
  const home = await mkHome();
  const before = stubServer.state.events.length;

  function countInstallMachine() {
    return stubServer.state.events.slice(before).filter((r) => r.event === 'install.machine').length;
  }

  async function simulatedLaunch({ now, appVersion }) {
    const client = freshClient(home, { appVersion });
    const boot = freshBoot();
    await boot.bootSequence({
      now,
      appVersion,
      installChannel: 'dev',
      deps: {
        telemetrySettings: require('../lib/telemetrySettings.cjs'),
        telemetryClient: client,
        buildMachineProfile: async () => fakeProfile({ appVersion }),
        telemetryCounters: { trackAppLaunch: () => {} },
      },
    });
    await client.flush('manual');
    client.shutdown();
  }

  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const ONE_DAY = 86400000;

  // Launches 1-5 at the same version, all inside 30 days.
  await simulatedLaunch({ now: t0, appVersion: '1.0.0' });
  await simulatedLaunch({ now: t0 + 1 * ONE_DAY, appVersion: '1.0.0' });
  await simulatedLaunch({ now: t0 + 2 * ONE_DAY, appVersion: '1.0.0' });
  await simulatedLaunch({ now: t0 + 3 * ONE_DAY, appVersion: '1.0.0' });
  await simulatedLaunch({ now: t0 + 4 * ONE_DAY, appVersion: '1.0.0' });
  expect(countInstallMachine()).toBe(1);

  // Launch 6: version bump.
  await simulatedLaunch({ now: t0 + 5 * ONE_DAY, appVersion: '1.1.0' });
  expect(countInstallMachine()).toBe(2);

  // Launch 7: 31 days after the version-bump report, same version -> heartbeat due.
  await simulatedLaunch({ now: t0 + 5 * ONE_DAY + 31 * ONE_DAY, appVersion: '1.1.0' });
  expect(countInstallMachine()).toBe(3);
});

// ═══════════════════════════════════════════════════════════════════════
// AC: version frozen at accumulation time, survives an upgrade
// ═══════════════════════════════════════════════════════════════════════

test('a record accumulated under one appVersion and flushed after an upgrade arrives stamped with the ORIGINAL version', async () => {
  const home = await mkHome();
  const before = stubServer.state.errors.length;

  const clientA = freshClient(home, { appVersion: '2.0.0' });
  await clientA.reportError({ name: 'PreUpgrade', msg: 'before', stack: 'PreUpgrade: before\n    at f (a.js:1:1)' });
  clientA.shutdown();

  const clientB = freshClient(home, { appVersion: '3.0.0' });
  await clientB.flush('manual');
  clientB.shutdown();

  const row = stubServer.state.errors[before];
  expect(row.version).toBe('2.0.0');
});

// ═══════════════════════════════════════════════════════════════════════
// AC: THE OVER-TRAFFIC TEST — 5 simulated launches, 40 lines delivered exactly once total
// ═══════════════════════════════════════════════════════════════════════

test('40 backlog error lines across two projects drain across FIVE simulated launches, delivered exactly once in total', async () => {
  const home = await mkHome();
  const projectA = await mkProject('traffic-a');
  const projectB = await mkProject('traffic-b');
  const day = recentDateStr();

  writeErrorsFile(projectA, day, Array.from({ length: 10 }, (_, i) => errLine(`a1-${i}`)));
  writeErrorsFile(projectA, recentDateStr(1), Array.from({ length: 10 }, (_, i) => errLine(`a2-${i}`)));
  writeErrorsFile(projectB, day, Array.from({ length: 10 }, (_, i) => errLine(`b1-${i}`)));
  writeErrorsFile(projectB, recentDateStr(1), Array.from({ length: 10 }, (_, i) => errLine(`b2-${i}`)));

  const before = stubServer.state.errors.length;
  const launchCounts = [];

  for (let launch = 0; launch < 5; launch++) {
    const client = freshClient(home);
    const backlog = freshBacklog();
    const deps = makeBacklogDeps({ telemetryClient: client, config: require('../config.cjs'), tabCwds: [projectA, projectB] });
    await backlog.drainBacklog({ now: Date.now(), deps });
    launchCounts.push(stubServer.state.errors.length - before - launchCounts.reduce((a, b) => a + b, 0));
    client.shutdown();
  }

  expect(launchCounts[0]).toBe(40);
  for (let i = 1; i < 5; i++) expect(launchCounts[i]).toBe(0);

  const totalReceived = stubServer.state.errors.length - before;
  expect(totalReceived).toBe(40);

  const recordIds = stubServer.state.errors.slice(before).map((r) => recordIdOf(r, 'errors'));
  expect(recordIds.every((id) => typeof id === 'string' && id)).toBe(true);
  expect(new Set(recordIds).size).toBe(40);
});

// ═══════════════════════════════════════════════════════════════════════
// AC: exactly-once across a failed send
// ═══════════════════════════════════════════════════════════════════════

test('records queued, a 503 mid-drain, then a fresh client flushing successfully — every record arrives exactly once, bytesConfirmed frozen during the failure', async () => {
  const home = await mkHome();
  const project = await mkProject('failed-send');
  writeErrorsFile(project, recentDateStr(), [errLine('fs-1'), errLine('fs-2'), errLine('fs-3')]);

  const before = stubServer.state.errors.length;

  // Round 1: the stub returns 503 for the next error-channel POST — the backlog
  // drainer durably enqueues the 3 records into the client's queue, but delivery fails.
  stubServer.queueOverride('error', 503, { error: 'service_unavailable' });
  const clientA = freshClient(home);
  const backlogA = freshBacklog();
  const depsA = makeBacklogDeps({ telemetryClient: clientA, config: require('../config.cjs'), tabCwds: [project] });
  await backlogA.drainBacklog({ now: Date.now(), deps: depsA });
  clientA.shutdown();

  expect(stubServer.state.errors.length).toBe(before); // nothing landed during the failure

  const wmPath = path.join(home, '.config', 'session-manager', 'telemetry-watermarks.json');
  const wmAfterFailure = JSON.parse(await fsp.readFile(wmPath, 'utf8'));
  const entryAfterFailure = Object.values(wmAfterFailure).find((e) => e && typeof e === 'object' && 'bytesConfirmed' in e);
  expect(entryAfterFailure.bytesConfirmed).toBe(0); // bytesConfirmed frozen during the failed phase
  expect(entryAfterFailure.bytesEnqueued).toBeGreaterThan(0);

  // "Restart": a fresh client against the same temp config dir picks up the
  // still-queued records (telemetryClient's own queue is the durable accumulator)
  // and flushes them successfully — no drainer involved this time.
  const clientB = freshClient(home);
  const result = await clientB.flush('manual');
  clientB.shutdown();

  expect(result.sent.length).toBe(3);
  expect(stubServer.state.errors.length - before).toBe(3); // exactly once, no duplicates, no loss

  const ids = stubServer.state.errors.slice(before).map((r) => recordIdOf(r, 'errors'));
  expect(new Set(ids).size).toBe(3);
});

// ═══════════════════════════════════════════════════════════════════════
// AC: eviction recovery
// ═══════════════════════════════════════════════════════════════════════

test('backlog lines force-evicted from the queue before delivery are re-sent exactly once after reconcile + drain, and watermarksRewound reports it', async () => {
  const home = await mkHome();
  const project = await mkProject('eviction');
  writeErrorsFile(project, recentDateStr(), [errLine('ev-1'), errLine('ev-2')]);

  const before = stubServer.state.errors.length;

  // Round 1: enqueue succeeds into the client's durable queue, but delivery fails.
  stubServer.queueOverride('error', 503, {});
  let client = freshClient(home);
  let backlog = freshBacklog();
  let deps = makeBacklogDeps({ telemetryClient: client, config: require('../config.cjs'), tabCwds: [project] });
  await backlog.drainBacklog({ now: Date.now(), deps });

  // Force-evict without delivering: wipe the durable queue file directly.
  await fsp.writeFile(client.queuePath(), '', 'utf8');
  client.shutdown();

  // Restart.
  client = freshClient(home);
  backlog = freshBacklog();
  deps = makeBacklogDeps({ telemetryClient: client, config: require('../config.cjs'), tabCwds: [project] });

  const reconcileSummary = await backlog.reconcileWatermarks({ now: Date.now(), deps });
  expect(reconcileSummary.watermarksRewound).toBe(1);

  const drainSummary = await backlog.drainBacklog({ now: Date.now(), deps });
  expect(drainSummary.linesEnqueued).toBe(2);
  client.shutdown();

  expect(stubServer.state.errors.length - before).toBe(2); // exactly once
});

// ═══════════════════════════════════════════════════════════════════════
// AC: log files untouched across the whole run (checked at the end, see final test)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// AC: daily cadence
// ═══════════════════════════════════════════════════════════════════════

test('cadence: 23h of idle ticks send nothing; the tick past 24h sends exactly once and persists lastDailyFlushAt', async () => {
  const home = await mkHome();

  process.env.HOME = home;
  for (const p of ['../lib/telemetrySettings.cjs', '../config.cjs']) delete require.cache[require.resolve(p)];
  const telemetrySettings = require('../lib/telemetrySettings.cjs');
  const seedNow = Date.now();
  await telemetrySettings.save({
    ...telemetrySettings.DEFAULTS,
    installId: crypto.randomUUID(),
    enabled: true,
    lastDailyFlushAt: new Date(seedNow).toISOString(),
  });

  vi.useFakeTimers();
  vi.setSystemTime(seedNow);

  const client = freshClient(home);
  const before = stubServer.state.events.length;
  await client.track('cadence.probe', { a: 1 });

  await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
  expect(stubServer.state.events.length).toBe(before); // no send during 23h of idle ticks

  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  client.shutdown();
  vi.useRealTimers();
  await new Promise((resolve) => { setTimeout(resolve, 200); }); // settle in-flight real I/O

  expect(stubServer.state.events.length).toBe(before + 1); // exactly one send after the 24h boundary

  const persisted = await telemetrySettings.load();
  expect(telemetrySettings.isDailyFlushDue(persisted, Date.now())).toBe(false); // lastDailyFlushAt persisted

  // A fresh client does not immediately re-send.
  const client2 = freshClient(home);
  await client2.flush('daily');
  expect(stubServer.state.events.length).toBe(before + 1);
  client2.shutdown();
}, 30000);

// ═══════════════════════════════════════════════════════════════════════
// AC: beacon header on every request; 401 stops further requests
// ═══════════════════════════════════════════════════════════════════════

test('X-SM-Beacon carries the resolved appVersion on every request; a 401 stops further requests for the process', async () => {
  const home = await mkHome();
  const client = freshClient(home, { appVersion: '4.5.6' });
  await client.track('beacon.check', { a: 1 });
  const before = stubServer.state.allRequests.length;
  await client.flush('manual');

  const reqsThisFlush = stubServer.state.allRequests.slice(before);
  expect(reqsThisFlush.length).toBeGreaterThan(0);
  for (const r of reqsThisFlush) {
    expect(r.headers['x-sm-beacon']).toBe('session-manager/4.5.6');
  }

  await client.track('beacon.check2', { a: 2 });
  stubServer.queueOverride('event', 401, { error: 'unauthorized' });
  await client.flush('manual');
  expect(client.status().disabledForProcess).toBe(true);

  const countAfterDisable = stubServer.state.allRequests.length;
  await client.flush('manual');
  expect(stubServer.state.allRequests.length).toBe(countAfterDisable); // no retry loop

  client.shutdown();
});

// ═══════════════════════════════════════════════════════════════════════
// AC: opt-out — zero requests reach the stub across every channel
// ═══════════════════════════════════════════════════════════════════════

test('SM_TELEMETRY=0: the stub receives zero requests across all three channels, drainBacklog, and flush()', async () => {
  const home = await mkHome();
  const project = await mkProject('optout');
  writeErrorsFile(project, recentDateStr(), [errLine('optout-1')]);

  process.env.SM_TELEMETRY = '0';
  const before = stubServer.state.allRequests.length;

  const client = freshClient(home);
  await client.track('optout.evt', { a: 1 });
  await client.logLine({ level: 'info', msg: 'x' });
  await client.reportError({ name: 'E', msg: 'x', stack: 'E: x\n    at f (a.js:1:1)' });
  const backlog = freshBacklog();
  const deps = makeBacklogDeps({ telemetryClient: client, config: require('../config.cjs'), tabCwds: [project] });
  await backlog.drainBacklog({ now: Date.now(), deps });
  await client.flush('manual');
  client.shutdown();

  expect(stubServer.state.allRequests.length).toBe(before);
});

// ═══════════════════════════════════════════════════════════════════════
// AC: privacy end-to-end
// ═══════════════════════════════════════════════════════════════════════

test('privacy: homedir, absolute paths, an API-key-shaped value, and a prompt-like sentence never reach the wire', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const secretPath = `${home}/projects/super-secret-app/src/index.js`;
  const apiKeyValue = 'sk-live-abcdef0123456789ABCDEF';
  const promptSentence = 'Please write a function that reverses a linked list in O(n) time.';

  const before = stubServer.state.allRequests.length;
  await client.reportError({
    name: 'PrivacyError',
    msg: 'boom',
    stack: `Error: boom\n    at ${secretPath}:12:4\n    at otherFrame (${os.homedir()}/other/file.js:1:1)`,
    // apiKey/transcript are REDACT_KEY-matching field names — this is the
    // realistic leak shape (a caller passing raw user/API content into error
    // context), which is exactly what redactDeep's key-based redaction guards.
    context: { apiKey: apiKeyValue, note: secretPath, transcript: promptSentence },
  });
  await client.flush('manual');

  const reqsThisFlush = stubServer.state.allRequests.slice(before);
  for (const r of reqsThisFlush) {
    expect(r.rawBody).not.toContain(os.homedir());
    expect(r.rawBody).not.toContain(secretPath);
    expect(r.rawBody).not.toContain(apiKeyValue);
    expect(r.rawBody).not.toContain(promptSentence);
  }
  client.shutdown();
});

// ═══════════════════════════════════════════════════════════════════════
// AC: THE ATTRIBUTION TEST + no-received-body-leaks-PII + log-files-untouched
// (run last: asserts across the ENTIRE test run's accumulated stub state)
// ═══════════════════════════════════════════════════════════════════════

test('FINAL ROLLUP: every persisted row across the whole run is attributable, no forbidden PII ever reached the wire, and every fixture file is untouched', async () => {
  // ── THE ATTRIBUTION TEST ──
  let unattributed = 0;
  for (const [table, rows] of [['events', stubServer.state.events], ['logs', stubServer.state.logs], ['errors', stubServer.state.errors]]) {
    for (const row of rows) {
      const { appVersion, machineDigest } = attributionOf(row, table);
      if (!appVersion || !machineDigest) {
        unattributed += 1;
      }
    }
  }
  expect(unattributed).toBe(0);
  expect(stubServer.state.events.length + stubServer.state.logs.length + stubServer.state.errors.length).toBeGreaterThan(0);

  // ── no received body ever contains a userInfo/hostname/IANA-timezone leak ──
  let username = null;
  try { username = os.userInfo().username; } catch { username = null; }
  const hostname = os.hostname();
  const ianaTzRe = /\b[A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+\b/;

  for (const r of stubServer.state.allRequests) {
    if (username) expect(r.rawBody).not.toContain(username);
    if (hostname) expect(r.rawBody).not.toContain(hostname);
    expect(ianaTzRe.test(r.rawBody)).toBe(false);
  }

  // ── log files untouched: byte-for-byte and mtime identical to right after they were written ──
  expect(fixtureSnapshots.length).toBeGreaterThan(0);
  for (const snap of fixtureSnapshots) {
    const stat = fs.statSync(snap.path);
    const bytes = fs.readFileSync(snap.path);
    expect(stat.mtimeMs).toBe(snap.mtimeMs);
    expect(Buffer.compare(bytes, snap.bytes)).toBe(0);
  }
});
