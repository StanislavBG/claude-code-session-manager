/**
 * telemetryClient.test.cjs — unit tests for the telemetry egress client.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/telemetryClient.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmpDirs = [];
let originalHome;
let originalSmTelemetry;
let originalSmTelemetryEndpoint;
let originalSmBeaconKey;
let originalSmTelemetrySpool;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalSmTelemetry = process.env.SM_TELEMETRY;
  originalSmTelemetryEndpoint = process.env.SM_TELEMETRY_ENDPOINT;
  originalSmBeaconKey = process.env.SM_BEACON_KEY;
  originalSmTelemetrySpool = process.env.SM_TELEMETRY_SPOOL;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalSmTelemetry === undefined) delete process.env.SM_TELEMETRY; else process.env.SM_TELEMETRY = originalSmTelemetry;
  if (originalSmTelemetryEndpoint === undefined) delete process.env.SM_TELEMETRY_ENDPOINT; else process.env.SM_TELEMETRY_ENDPOINT = originalSmTelemetryEndpoint;
  if (originalSmBeaconKey === undefined) delete process.env.SM_BEACON_KEY; else process.env.SM_BEACON_KEY = originalSmBeaconKey;
  if (originalSmTelemetrySpool === undefined) delete process.env.SM_TELEMETRY_SPOOL; else process.env.SM_TELEMETRY_SPOOL = originalSmTelemetrySpool;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-telemetry-client-home-'));
  tmpDirs.push(dir);
  return dir;
}

function fakeProfile(overrides = {}) {
  return {
    appVersion: '0.81.0',
    platform: 'linux',
    arch: 'x64',
    machineDigest: 'deadbeefcafe',
    installChannel: 'dev',
    osRelease: '6.1.0',
    cpuCount: 8,
    totalMemMb: 16384,
    nodeVersion: '20.11.0',
    electronVersion: '33.0.0',
    locale: 'en-US',
    timezoneOffsetMinutes: 420,
    ...overrides,
  };
}

/**
 * Loads a fresh telemetryClient module instance bound to `home`, with its
 * config.cjs/telemetrySettings.cjs deps also reloaded (config.cjs computes
 * its allowedRoots from os.homedir() at require time, so it must be
 * reloaded whenever HOME changes — same pattern telemetrySettings.test.cjs
 * uses). Injects a stub machine-profile builder so tests never spawn the
 * real claude CLI probe.
 */
function freshClient(home, profileOverrides) {
  process.env.HOME = home;
  // Explicit opt-in: this suite deliberately exercises telemetryClient's real
  // queue/sent-file I/O, so it must override the test-environment no-op guard
  // by pointing the spool at this test's own isolated tmp dir (never a real
  // user's ~/.claude/session-manager).
  process.env.SM_TELEMETRY_SPOOL = path.join(home, '.claude', 'session-manager');
  for (const p of ['../lib/telemetryClient.cjs', '../config.cjs', '../lib/telemetrySettings.cjs', '../lib/machineProfile.cjs']) {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  }
  const client = require('../lib/telemetryClient.cjs');
  const profile = fakeProfile(profileOverrides);
  client._setMachineProfileBuilder(async () => profile);
  return client;
}

function fetchStub(responder) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    const rec = { url, opts, body: JSON.parse(opts.body) };
    calls.push(rec);
    const res = await responder(rec, calls.length);
    return res;
  });
  fn.calls = calls;
  return fn;
}

function okResponse() {
  return { ok: true, status: 200 };
}

function statusResponse(status) {
  return { ok: false, status };
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

// ─── exports ────────────────────────────────────────────────────────────

test('exports the full contract', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  for (const fn of ['track', 'logLine', 'reportError', 'reportInstall', 'flush', 'shutdown', 'status', 'recentRecords', 'isPending']) {
    expect(typeof client[fn]).toBe('function');
  }
  client.shutdown();
});

// ─── never throws ──────────────────────────────────────────────────────

test('ingress functions never throw on hostile inputs', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  client._setFetchImpl(fetchStub(async () => okResponse()));
  const circular = { a: 1 };
  circular.self = circular;
  const huge = 'x'.repeat(2 * 1024 * 1024);

  for (const bad of [null, undefined, circular, huge]) {
    await expect(client.track(bad, bad)).resolves.toBeDefined();
    await expect(client.logLine(bad)).resolves.toBeDefined();
    await expect(client.reportError(bad)).resolves.toBeDefined();
    await expect(client.reportInstall(bad)).resolves.toBeDefined();
  }
  client.shutdown();
});

// ─── reportInstall failure visibility ──────────────────────────────────

test('reportInstall logs a warn line naming the thrown error instead of swallowing it silently', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  client._setMachineProfileBuilder(() => { throw new Error('boom-profile'); });
  const warnLines = [];
  client._setLogger((payload) => warnLines.push(payload));

  const result = await client.reportInstall(fakeProfile());

  expect(result).toEqual({ accepted: false, reason: 'error' });
  expect(warnLines).toHaveLength(1);
  expect(warnLines[0].scope).toBe('telemetry');
  expect(warnLines[0].level).toBe('warn');
  expect(warnLines[0].message).toBe('reportInstall failed');
  expect(warnLines[0].meta.error).toContain('boom-profile');
  client.shutdown();
});

// ─── disabled at ingress ───────────────────────────────────────────────

test('when telemetry is disabled, ingress drops at the point of entry', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);
  process.env.SM_TELEMETRY = '0';

  await client.track('evt', { a: 1 });
  await client.logLine({ level: 'info', msg: 'hi' });
  await client.reportError({ name: 'E', msg: 'boom', stack: 'at x' });
  await client.reportInstall(fakeProfile());

  expect(client.status().pendingCount).toBe(0);
  expect(await readQueueLines(client)).toEqual([]);
  expect(fetchFn).not.toHaveBeenCalled();
  client.shutdown();
});

// ─── version stamp ─────────────────────────────────────────────────────

test('every record on all three channels carries the four attribution fields', async () => {
  const home = await mkHome();
  const client = freshClient(home, { appVersion: '0.81.0', platform: 'linux', arch: 'x64', machineDigest: 'deadbeefcafe' });

  await client.track('evt', { a: 1 });
  await client.logLine({ level: 'info', msg: 'hi' });
  await client.reportError({ name: 'E', msg: 'boom', stack: 'Error: boom\n    at fn (x.js:1:1)' });

  const [eventRec, logRec, errorRec] = await readQueueLines(client);

  for (const f of ['appVersion', 'platform', 'arch', 'machineDigest']) {
    expect(eventRec.wire.props[f]).toBeTruthy();
  }
  expect(logRec.wire.version).toBe('0.81.0');
  for (const f of ['platform', 'arch', 'machineDigest']) expect(logRec.wire.fields[f]).toBeTruthy();
  expect(errorRec.wire.version).toBe('0.81.0');
  for (const f of ['platform', 'arch', 'machineDigest']) expect(errorRec.wire.context[f]).toBeTruthy();

  client.shutdown();
});

test('event channel nests all four attribution fields in props because funnel_events has no version column', async () => {
  const home = await mkHome();
  const client = freshClient(home, { appVersion: '0.81.0' });
  await client.track('evt', { a: 1 });
  const [rec] = await readQueueLines(client);
  // Simulate exactly what the deployed INSERT persists: event, tool, metadata, session_id, visitor_id, path.
  const persisted = {
    event: rec.wire.name,
    tool: rec.wire.app,
    metadata: JSON.stringify(rec.wire.props),
    session_id: rec.wire.session_id,
    visitor_id: rec.wire.visitor_id,
  };
  const recoveredMeta = JSON.parse(persisted.metadata);
  expect(recoveredMeta.appVersion).toBe('0.81.0');
  expect(recoveredMeta.platform).toBeTruthy();
  expect(recoveredMeta.arch).toBeTruthy();
  expect(recoveredMeta.machineDigest).toBeTruthy();
  client.shutdown();
});

test('log/error channels put version in the top-level field the route reads, and the rest in fields/context', async () => {
  const home = await mkHome();
  const client = freshClient(home, { appVersion: '0.81.0' });
  await client.logLine({ level: 'warn', msg: 'careful' });
  await client.reportError({ name: 'E', msg: 'boom', stack: 'Error: boom\n    at f (a.js:1:1)' });
  const [logRec, errRec] = await readQueueLines(client);

  // app_logs INSERT reads l.version directly (no join needed).
  expect(logRec.wire.version).toBe('0.81.0');
  const recoveredLogFields = JSON.parse(JSON.stringify(logRec.wire.fields));
  expect(recoveredLogFields.platform).toBeTruthy();
  expect(recoveredLogFields.arch).toBeTruthy();
  expect(recoveredLogFields.machineDigest).toBeTruthy();

  expect(errRec.wire.version).toBe('0.81.0');
  const recoveredCtx = JSON.parse(JSON.stringify(errRec.wire.context));
  expect(recoveredCtx.platform).toBeTruthy();
  expect(recoveredCtx.arch).toBeTruthy();
  expect(recoveredCtx.machineDigest).toBeTruthy();
  client.shutdown();
});

// ─── profile resolved once ─────────────────────────────────────────────

test('buildMachineProfile is invoked at most once across 100 ingress calls', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  let calls = 0;
  client._setMachineProfileBuilder(async () => {
    calls += 1;
    return fakeProfile();
  });
  for (let i = 0; i < 100; i++) {
    await client.track('evt', { i });
  }
  expect(calls).toBeLessThanOrEqual(1);
  expect(client.status().profileBuildCount).toBeLessThanOrEqual(1);
  client.shutdown();
});

// ─── attribution survives redaction + clamps ───────────────────────────

test('attribution fields are exempt from redaction/clamping and arrive byte-identical, even when user content is truncated', async () => {
  const home = await mkHome();
  const client = freshClient(home, { appVersion: '0.81.0-exact', machineDigest: 'cafebabe0001' });
  const bigProps = {};
  for (let i = 0; i < 60; i++) bigProps[`k${i}`] = 'y'.repeat(500);
  await client.track('evt', bigProps);
  const [rec] = await readQueueLines(client);
  expect(rec.wire.props.appVersion).toBe('0.81.0-exact');
  expect(rec.wire.props.machineDigest).toBe('cafebabe0001');
  expect(rec.wire.props._truncated).toBe(true);
  client.shutdown();
});

// ─── env discriminator (wire-level, all four channels) ─────────────────

test('every channel carries env:"dev" when SM_DEV drives installChannel, and it survives the queue round-trip through flush', async () => {
  const home = await mkHome();
  const client = freshClient(home, { installChannel: 'dev' });
  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);

  await client.track('evt', { a: 1 });
  await client.logLine({ level: 'info', msg: 'hi' });
  await client.reportError({ name: 'E', msg: 'boom', stack: 'at x' });
  await client.reportInstall(fakeProfile({ installChannel: 'dev' }));

  // Present the instant it's appended to telemetry-queue.jsonl, before any flush.
  const queued = await readQueueLines(client);
  expect(queued).toHaveLength(4);
  for (const rec of queued) expect(rec.wire.env).toBe('dev');

  // Still present in the exact body flush() POSTs.
  await client.flush('manual');
  expect(fetchFn.calls.length).toBeGreaterThan(0);
  for (const call of fetchFn.calls) {
    const bodies = Array.isArray(call.body.batch) ? call.body.batch : [call.body];
    for (const wire of bodies) expect(wire.env).toBe('dev');
  }
  client.shutdown();
});

test('every channel carries env:"prod" for a non-dev installChannel', async () => {
  const home = await mkHome();
  const client = freshClient(home, { installChannel: 'npx' });

  await client.track('evt', { a: 1 });
  await client.logLine({ level: 'info', msg: 'hi' });
  await client.reportError({ name: 'E', msg: 'boom', stack: 'at x' });
  await client.reportInstall(fakeProfile({ installChannel: 'npx' }));

  const queued = await readQueueLines(client);
  expect(queued).toHaveLength(4);
  for (const rec of queued) expect(rec.wire.env).toBe('prod');
  client.shutdown();
});

test('env resolves to "test" under a real test-runner environment, independent of installChannel', () => {
  const machineProfile = require('../lib/machineProfile.cjs');
  expect(machineProfile.resolveEnv({ isTestRunner: true, installChannel: 'dev' })).toBe('test');
  expect(machineProfile.resolveEnv({ isTestRunner: true, installChannel: 'npx' })).toBe('test');
});

// ─── queue is the accumulator, survives restart ────────────────────────

test('a record survives a simulated process restart and is still pending', async () => {
  const home = await mkHome();
  const clientA = freshClient(home);
  const { recordId } = await clientA.track('evt', { a: 1 });
  expect(await clientA.isPending(recordId)).toBe(true);
  clientA.shutdown();

  const clientB = freshClient(home);
  expect(await clientB.isPending(recordId)).toBe(true);
  expect(clientB.status().pendingCount).toBe(1);
  clientB.shutdown();
});

// ─── version frozen at creation ────────────────────────────────────────

test('a record accumulated on one version and flushed after an upgrade still carries the original version', async () => {
  const home = await mkHome();
  const clientA = freshClient(home, { appVersion: '0.81.0' });
  await clientA.track('evt', { a: 1 });
  clientA.shutdown();

  const clientB = freshClient(home, { appVersion: '0.82.0' });
  const fetchFn = fetchStub(async () => okResponse());
  clientB._setFetchImpl(fetchFn);
  const result = await clientB.flush('manual');

  expect(result.sent.length).toBe(1);
  const sentBody = fetchFn.calls[0].body;
  expect(sentBody.batch[0].props.appVersion).toBe('0.81.0');
  clientB.shutdown();
});

// ─── recordId ───────────────────────────────────────────────────────────

test('a caller-supplied recordId is preserved verbatim onto the wire', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const result = await client.track('evt', { recordId: 'drainer-fixed-id-1', a: 1 });
  expect(result.recordId).toBe('drainer-fixed-id-1');
  const [rec] = await readQueueLines(client);
  expect(rec.recordId).toBe('drainer-fixed-id-1');
  expect(rec.wire.props.recordId).toBe('drainer-fixed-id-1');
  client.shutdown();
});

// ─── idempotent append / over-traffic guard ────────────────────────────

test('appending the same recordId three times across a restart results in exactly one POST', async () => {
  const home = await mkHome();
  const id = 'over-traffic-id-1';

  const clientA = freshClient(home);
  const r1 = await clientA.track('evt', { recordId: id });
  const r2 = await clientA.track('evt', { recordId: id });
  expect(r1.accepted).toBe(true);
  expect(r2.accepted).toBe(false);
  expect(clientA.status().dedupedAppends).toBe(1);

  const fetchFnA = fetchStub(async () => okResponse());
  clientA._setFetchImpl(fetchFnA);
  await clientA.flush('manual');
  expect(fetchFnA).toHaveBeenCalledTimes(1);
  clientA.shutdown();

  const clientB = freshClient(home);
  const r3 = await clientB.track('evt', { recordId: id });
  expect(r3.accepted).toBe(false);
  expect(clientB.status().dedupedAppends).toBe(1);

  const fetchFnB = fetchStub(async () => okResponse());
  clientB._setFetchImpl(fetchFnB);
  await clientB.flush('manual');
  expect(fetchFnB).not.toHaveBeenCalled();
  clientB.shutdown();
});

// ─── recently-sent set persistence ──────────────────────────────────────

test('the recently-sent set persists across a restart', async () => {
  const home = await mkHome();
  const clientA = freshClient(home);
  const { recordId } = await clientA.track('evt', { a: 1 });
  const fetchFn = fetchStub(async () => okResponse());
  clientA._setFetchImpl(fetchFn);
  const result = await clientA.flush('manual');
  expect(result.sent).toEqual([recordId]);
  clientA.shutdown();

  const raw = JSON.parse(fs.readFileSync(clientA.sentPath(), 'utf8'));
  expect(raw.ids).toContain(recordId);

  const clientB = freshClient(home);
  expect(await clientB.isPending(recordId)).toBe(false);
  const r2 = await clientB.track('evt', { recordId });
  expect(r2.accepted).toBe(false);
  clientB.shutdown();
});

test('the recently-sent set FIFO-evicts at its 5000 cap', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);

  const firstId = 'sent-cap-0';
  for (let i = 0; i < 5001; i++) {
    await client.track('evt', { recordId: `sent-cap-${i}` });
  }
  await client.flush('manual');

  const raw = JSON.parse(fs.readFileSync(client.sentPath(), 'utf8'));
  expect(raw.ids.length).toBe(5000);
  expect(raw.ids).not.toContain(firstId);

  const reAppend = await client.track('evt', { recordId: firstId });
  expect(reAppend.accepted).toBe(true);
  client.shutdown();
}, 60000);

// ─── delivery confirmation ──────────────────────────────────────────────

test('flush reports a partial failure precisely: batch 1 sent, batch 2 failed, batch 3 untouched', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const ids = [];
  for (let i = 0; i < 150; i++) {
    const r = await client.track('evt', { recordId: `part-${i}`, i });
    ids.push(r.recordId);
  }
  const batch1Ids = ids.slice(0, 50);
  const batch2Ids = ids.slice(50, 100);
  const batch3Ids = ids.slice(100, 150);

  let call = 0;
  const fetchFn = fetchStub(async () => {
    call += 1;
    if (call === 1) return okResponse();
    return statusResponse(500);
  });
  client._setFetchImpl(fetchFn);

  const result = await client.flush('manual');
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(result.sent.sort()).toEqual([...batch1Ids].sort());
  expect(result.failed.sort()).toEqual([...batch2Ids].sort());
  for (const id of batch3Ids) {
    expect(result.sent).not.toContain(id);
    expect(result.failed).not.toContain(id);
    expect(await client.isPending(id)).toBe(true);
  }
  client.shutdown();
}, 30000);

// ─── cadence ─────────────────────────────────────────────────────────────

test('cadence: 23h of hourly ticks send nothing, the tick past 24h sends once and re-arms', async () => {
  const home = await mkHome();

  // Seed lastDailyFlushAt = now, simulating a boot flush that already ran.
  process.env.HOME = home;
  delete require.cache[require.resolve('../lib/telemetrySettings.cjs')];
  delete require.cache[require.resolve('../config.cjs')];
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
  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);
  await client.track('evt', { a: 1 });

  await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
  expect(fetchFn).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
  client.shutdown();
  // The hourly tick's flush() does real (unfaked) fs I/O that can still be
  // in flight when advanceTimersByTimeAsync returns — settle it under real
  // timers before asserting, so this test doesn't race the next test's HOME
  // reset in afterEach.
  vi.useRealTimers();
  await new Promise((resolve) => { setTimeout(resolve, 200); });

  expect(fetchFn).toHaveBeenCalledTimes(1);
  const persisted = await telemetrySettings.load();
  expect(telemetrySettings.isDailyFlushDue(persisted, Date.now())).toBe(false);
}, 30000);

// ─── mark-done + concurrent append ──────────────────────────────────────

test('mark-done removes only sent records; a record appended mid-flight is not lost', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const { recordId: firstId } = await client.track('evt', { a: 1 });

  let midflightId = null;
  const fetchFn = fetchStub(async () => {
    const r = await client.track('evt', { recordId: 'midflight-1' });
    midflightId = r.recordId;
    return okResponse();
  });
  client._setFetchImpl(fetchFn);

  const result = await client.flush('manual');
  expect(result.sent).toEqual([firstId]);
  expect(midflightId).toBe('midflight-1');
  expect(await client.isPending('midflight-1')).toBe(true);

  const lines = await readQueueLines(client);
  expect(lines.map((l) => l.recordId)).toEqual(['midflight-1']);
  client.shutdown();
});

// ─── batch shape ─────────────────────────────────────────────────────────

test('120 queued records drain in 3 POSTs of <=50 within one flush', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  for (let i = 0; i < 120; i++) {
    await client.track('evt', { recordId: `batch-${i}`, i });
  }
  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);
  const result = await client.flush('manual');

  expect(fetchFn).toHaveBeenCalledTimes(3);
  expect(fetchFn.calls[0].body.batch.length).toBe(50);
  expect(fetchFn.calls[1].body.batch.length).toBe(50);
  expect(fetchFn.calls[2].body.batch.length).toBe(20);
  expect(result.sent.length).toBe(120);
  expect(client.status().pendingCount).toBe(0);
  client.shutdown();
}, 30000);

// ─── field names match server contract exactly ──────────────────────────

test('wire field names match server/routes/telemetry.ts exactly', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt-name', { a: 1 });
  await client.logLine({ level: 'warn', msg: 'm', fields: { b: 2 } });
  await client.reportError({ name: 'E', msg: 'm', stack: 'Error: m\n    at f (a.js:1:1)', context: { c: 3 } });
  await client.reportInstall(fakeProfile());

  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);
  await client.flush('manual');

  const eventCall = fetchFn.calls.find((c) => c.url.endsWith('/event'));
  const logCall = fetchFn.calls.find((c) => c.url.endsWith('/log'));
  const errorCall = fetchFn.calls.find((c) => c.url.endsWith('/error'));
  const installCall = fetchFn.calls.find((c) => c.url.endsWith('/install'));

  expect(Object.keys(eventCall.body.batch[0]).sort()).toEqual(['app', 'env', 'name', 'props', 'session_id', 'visitor_id'].sort());
  expect(Object.keys(logCall.body.batch[0]).sort()).toEqual(['app', 'env', 'version', 'level', 'msg', 'visitor_id', 'session_id', 'fields', 'ts'].sort());
  expect(Object.keys(errorCall.body.batch[0]).sort()).toEqual(['app', 'env', 'version', 'name', 'msg', 'stack', 'url', 'ua', 'visitor_id', 'session_id', 'context', 'ts'].sort());
  expect(Object.keys(installCall.body).sort()).toEqual([
    'app', 'app_version', 'arch', 'cpu_count', 'electron_version', 'env',
    'install_channel', 'install_id', 'locale', 'node_version',
    'os_release', 'platform', 'timezone', 'total_mem_mb',
  ].sort());
  client.shutdown();
});

// ─── beacon auth header ──────────────────────────────────────────────────

test('every request carries the X-SM-Beacon header with the resolved appVersion', async () => {
  const home = await mkHome();
  const client = freshClient(home, { appVersion: '0.81.0' });
  await client.track('evt', { a: 1 });
  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);
  await client.flush('manual');
  expect(fetchFn.calls[0].opts.headers['X-SM-Beacon']).toBe('session-manager/0.81.0');
  expect(fetchFn.calls[0].opts.headers['X-SM-Beacon-Key']).toBeTruthy();
  client.shutdown();
});

test('a 401 disables the client for the rest of the process instead of retrying forever', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });
  const fetchFn = fetchStub(async () => statusResponse(401));
  client._setFetchImpl(fetchFn);

  await client.flush('manual');
  expect(client.status().disabledForProcess).toBe(true);

  await client.flush('manual');
  expect(fetchFn).toHaveBeenCalledTimes(1);
  client.shutdown();
});

// ─── redaction ───────────────────────────────────────────────────────────

test('redaction: homedir -> ~, absolute paths -> basename, REDACT_KEY keys -> [redacted], strings clamped', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const longMsg = 'm'.repeat(600);
  const longStack = 's'.repeat(20000);
  await client.reportError({
    name: 'E',
    msg: longMsg,
    stack: longStack,
    context: {
      token: 'super-secret-value',
      note: `${home}/projects/app/file.js and /tmp/other/dir/leaf.txt`,
    },
  });
  const [rec] = await readQueueLines(client);
  expect(rec.wire.msg.length).toBeLessThanOrEqual(500);
  expect(rec.wire.stack.length).toBeLessThanOrEqual(16000);
  expect(rec.wire.context.token).toBe('[redacted]');
  expect(rec.wire.context.note).not.toContain(home);
  expect(rec.wire.context.note).toContain('~/projects/app/file.js');
  expect(rec.wire.context.note).toContain('leaf.txt');
  expect(rec.wire.context.note).not.toContain('/tmp/other/dir/leaf.txt');
  client.shutdown();
});

// ─── cwd -> projectHash ──────────────────────────────────────────────────

test('a project cwd is never sent verbatim; only projectHash is emitted', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const cwd = '/home/bilko/Projects/super-secret-client-project';
  await client.track('evt', { cwd, other: 'x' });
  const [rec] = await readQueueLines(client);
  const serialized = JSON.stringify(rec);
  expect(serialized).not.toContain(cwd);
  expect(rec.wire.props.projectHash).toMatch(/^[0-9a-f]{12}$/);
  expect(rec.wire.props.cwd).toBeUndefined();
  client.shutdown();
});

// ─── error dedup ─────────────────────────────────────────────────────────

test('error de-duplication allows at most 3 identical signatures per 60s window', async () => {
  const home = await mkHome();
  vi.useFakeTimers();
  const client = freshClient(home);
  const errArgs = { name: 'BoomError', msg: 'x', stack: 'BoomError: x\n    at f (a.js:1:1)' };

  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await client.reportError(errArgs));
  }
  expect(results.filter((r) => r.accepted).length).toBe(3);
  expect(client.status().pendingCount).toBe(3);

  await vi.advanceTimersByTimeAsync(61 * 1000);
  const after = await client.reportError(errArgs);
  expect(after.accepted).toBe(true);

  client.shutdown();
  vi.useRealTimers();
});

// ─── queue cap + counters ────────────────────────────────────────────────

test('queue file is capped at 5000 records with oldest-first eviction; status() reports evictedCount', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  for (let i = 0; i < 5010; i++) {
    await client.track('evt', { recordId: `cap-${i}`, i });
  }
  const st = client.status();
  expect(st.pendingCount).toBe(5000);
  expect(st.evictedCount).toBe(10);
  expect(await client.isPending('cap-0')).toBe(false);
  expect(await client.isPending('cap-5009')).toBe(true);
  const lines = await readQueueLines(client);
  expect(lines.length).toBe(5000);
  client.shutdown();
}, 60000);

test('dedupedAppends is visible on status()', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt', { recordId: 'dd-1' });
  await client.track('evt', { recordId: 'dd-1' });
  await client.track('evt', { recordId: 'dd-1' });
  expect(client.status().dedupedAppends).toBe(2);
  client.shutdown();
});

// ─── failure backoff ─────────────────────────────────────────────────────

test('backoff: consecutive 5xx/429 failures back off exponentially and leave the queue intact', async () => {
  const home = await mkHome();
  vi.useFakeTimers();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });

  const fetchFn = fetchStub(async () => statusResponse(500));
  client._setFetchImpl(fetchFn);

  const r1 = await client.flush('manual');
  expect(r1.failed.length).toBe(1);
  expect(client.status().pendingCount).toBe(1);
  const backoff1 = client.status().backoffUntil - Date.now();
  expect(backoff1).toBeGreaterThanOrEqual(60 * 1000 - 10);

  // Still backed off: a flush attempted before the window elapses does nothing.
  const r2 = await client.flush('manual');
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(r2.sent).toEqual([]);
  expect(r2.failed).toEqual([]);

  await vi.advanceTimersByTimeAsync(backoff1 + 10);
  await client.flush('manual');
  expect(fetchFn).toHaveBeenCalledTimes(2);
  const backoff2 = client.status().backoffUntil - Date.now();
  expect(backoff2).toBeGreaterThan(backoff1);

  client.shutdown();
  vi.useRealTimers();
}, 30000);

test('backoff ceiling: exponential growth caps at 6h', async () => {
  const home = await mkHome();
  vi.useFakeTimers();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });
  client._setFetchImpl(fetchStub(async () => statusResponse(503)));

  for (let i = 0; i < 12; i++) {
    await client.flush('manual');
    const remaining = client.status().backoffUntil - Date.now();
    if (remaining > 0) await vi.advanceTimersByTimeAsync(remaining + 10);
  }
  expect(client.status().backoffUntil - Date.now()).toBeLessThanOrEqual(6 * 60 * 60 * 1000);

  client.shutdown();
  vi.useRealTimers();
}, 30000);

test('a non-429 4xx disables the client (malformed-contract circuit breaker), not backoff', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });
  client._setFetchImpl(fetchStub(async () => statusResponse(400)));
  await client.flush('manual');
  const st = client.status();
  expect(st.disabledForProcess).toBe(true);
  expect(st.pendingCount).toBe(1);
  client.shutdown();
});

test('429 backs off rather than disabling', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });
  client._setFetchImpl(fetchStub(async () => statusResponse(429)));
  await client.flush('manual');
  const st = client.status();
  expect(st.disabledForProcess).toBe(false);
  expect(st.backoffUntil).toBeGreaterThan(Date.now() - 1);
  client.shutdown();
});

// ─── recentRecords ring buffer ───────────────────────────────────────────

test('recentRecords() is a bounded ring buffer of at most 20', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  for (let i = 0; i < 25; i++) {
    await client.track('evt', { recordId: `ring-${i}`, i });
  }
  const recent = client.recentRecords();
  expect(recent.length).toBe(20);
  expect(recent[recent.length - 1].recordId).toBe('ring-24');
  client.shutdown();
});

// ─── fetch injectability ─────────────────────────────────────────────────

test('the default path uses global fetch when no injection is made', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });
  const globalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', globalFetch);
  await client.flush('manual');
  expect(globalFetch).toHaveBeenCalledTimes(1);
  client.shutdown();
});

// ─── status(): lastError / lastFlushAt / lastFlushReason (PRD 1142) ──────

test('status() exposes the last error and clears it on a subsequent successful flush', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  vi.useFakeTimers();
  await client.track('evt', { a: 1 });
  client._setFetchImpl(fetchStub(async () => statusResponse(500)));
  await client.flush('manual');
  let st = client.status();
  expect(st.lastError).toEqual(expect.objectContaining({ status: 500, message: 'HTTP 500' }));
  expect(st.lastFlushAt).toBeGreaterThan(0);
  expect(st.lastFlushReason).toBe('manual');

  // Past the backoff window this failure armed, so the next flush actually attempts delivery.
  vi.advanceTimersByTime(6 * 60 * 1000 + 1000);
  client._setFetchImpl(fetchStub(async () => okResponse()));
  await client.flush('boot');
  st = client.status();
  expect(st.lastError).toBeNull();
  expect(st.lastFlushReason).toBe('boot');
  client.shutdown();
});

test('status() reports a network error (fetch throw / status 0) with a plain-language message', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });
  client._setFetchImpl(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
  await client.flush('manual');
  const st = client.status();
  expect(st.lastError).toEqual(expect.objectContaining({ status: 0, message: 'network error' }));
  client.shutdown();
});

// ─── test-environment guard (poisoned-spool prevention) ─────────────────

test('appendRecord() is a no-op under a test runner unless SM_TELEMETRY_SPOOL is explicitly set', async () => {
  const home = await mkHome();
  process.env.HOME = home;
  delete process.env.SM_TELEMETRY_SPOOL;
  for (const p of ['../lib/telemetryClient.cjs', '../config.cjs', '../lib/telemetrySettings.cjs', '../lib/machineProfile.cjs']) {
    delete require.cache[require.resolve(p)];
  }
  const client = require('../lib/telemetryClient.cjs');
  client._setMachineProfileBuilder(async () => fakeProfile());

  expect(process.env.VITEST).toBeTruthy();
  const trackResult = await client.track('evt', { a: 1 });
  const logResult = await client.logLine({ level: 'info', msg: 'hi' });
  const errorResult = await client.reportError({ name: 'E', msg: 'boom', stack: 'at x' });

  expect(trackResult).toEqual({ accepted: false, reason: 'test-environment', recordId: expect.any(String) });
  expect(logResult.accepted).toBe(false);
  expect(errorResult.accepted).toBe(false);
  expect(client.status().pendingCount).toBe(0);
  await expect(fsp.access(client.queuePath())).rejects.toThrow();
  client.shutdown();
});

// ─── clearQueue (opt-out side effect, PRD 1142) ──────────────────────────

test('clearQueue() empties the in-memory queue and truncates the on-disk queue file', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.track('evt', { a: 1 });
  await client.track('evt', { a: 2 });
  expect(client.status().pendingCount).toBe(2);

  await client.clearQueue();
  expect(client.status().pendingCount).toBe(0);
  const raw = await fsp.readFile(client.queuePath(), 'utf8');
  expect(raw.trim()).toBe('');
  client.shutdown();
});

// ─── install channel (PRD: bilko.run app_installs) ──────────────────────

test('reportInstall() maps buildMachineProfile()\'s camelCase onto the exact snake_case key set app_installs expects', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  const profile = fakeProfile();
  await client.reportInstall(profile);
  const [rec] = await readQueueLines(client);

  expect(rec.channel).toBe('install');
  expect(Object.keys(rec.wire).sort()).toEqual([
    'app', 'app_version', 'arch', 'cpu_count', 'electron_version', 'env',
    'install_channel', 'install_id', 'locale', 'node_version',
    'os_release', 'platform', 'timezone', 'total_mem_mb',
  ].sort());
  expect(rec.wire.app).toBe('session-manager');
  expect(rec.wire.app_version).toBe(profile.appVersion);
  expect(rec.wire.platform).toBe(profile.platform);
  expect(rec.wire.os_release).toBe(profile.osRelease);
  expect(rec.wire.arch).toBe(profile.arch);
  expect(rec.wire.cpu_count).toBe(profile.cpuCount);
  expect(rec.wire.total_mem_mb).toBe(profile.totalMemMb);
  expect(rec.wire.node_version).toBe(profile.nodeVersion);
  expect(rec.wire.electron_version).toBe(profile.electronVersion);
  expect(rec.wire.install_channel).toBe(profile.installChannel);
  expect(rec.wire.locale).toBe(profile.locale);
  expect(rec.wire.timezone).toBe(String(profile.timezoneOffsetMinutes));
  expect(typeof rec.wire.install_id).toBe('string');
  expect(rec.wire.install_id).toBeTruthy();
  client.shutdown();
});

test('the install channel POSTs a flat body, never a {batch:[...]} envelope', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.reportInstall(fakeProfile());
  const fetchFn = fetchStub(async () => okResponse());
  client._setFetchImpl(fetchFn);
  const result = await client.flush('manual');

  expect(result.sent.length).toBe(1);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(fetchFn.calls[0].url.endsWith('/api/telemetry/install')).toBe(true);
  expect(fetchFn.calls[0].body.batch).toBeUndefined();
  expect(fetchFn.calls[0].body.install_id).toBeTruthy();
  client.shutdown();
});

test('a 400 on the install channel disables the client like any other malformed-contract 4xx', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.reportInstall(fakeProfile());
  client._setFetchImpl(fetchStub(async () => statusResponse(400)));
  await client.flush('manual');
  const st = client.status();
  expect(st.disabledForProcess).toBe(true);
  expect(st.pendingCount).toBe(1);
  client.shutdown();
});

test('a 429 on the install channel backs off rather than disabling, same as event/log/error', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  await client.reportInstall(fakeProfile());
  client._setFetchImpl(fetchStub(async () => statusResponse(429)));
  await client.flush('manual');
  const st = client.status();
  expect(st.disabledForProcess).toBe(false);
  expect(st.backoffUntil).toBeGreaterThan(Date.now() - 1);
  expect(st.pendingCount).toBe(1);
  client.shutdown();
});

test('a stub server bound to 127.0.0.1 receives exactly one well-formed install POST during a simulated boot', async () => {
  const http = require('node:http');
  const home = await mkHome();
  let received = null;
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/telemetry/install') {
      requestCount += 1;
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  process.env.SM_TELEMETRY_ENDPOINT = `http://127.0.0.1:${port}`;

  try {
    const client = freshClient(home);
    // No _setFetchImpl — exercises the real global fetch path against the local stub.
    const profile = fakeProfile();
    await client.reportInstall(profile);
    await client.flush('boot');

    expect(requestCount).toBe(1);
    expect(received).toEqual({
      install_id: expect.any(String),
      app: 'session-manager',
      app_version: profile.appVersion,
      platform: profile.platform,
      os_release: profile.osRelease,
      arch: profile.arch,
      cpu_count: profile.cpuCount,
      total_mem_mb: profile.totalMemMb,
      node_version: profile.nodeVersion,
      electron_version: profile.electronVersion,
      install_channel: profile.installChannel,
      locale: profile.locale,
      timezone: String(profile.timezoneOffsetMinutes),
      env: 'dev',
    });
    client.shutdown();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}, 15000);

test('clearQueue() never touches telemetry-sent.json', async () => {
  const home = await mkHome();
  const client = freshClient(home);
  client._setFetchImpl(fetchStub(async () => okResponse()));
  await client.track('evt', { a: 1 });
  await client.flush('manual');
  const sentBefore = await fsp.readFile(client.sentPath(), 'utf8');

  await client.track('evt', { a: 2 });
  await client.clearQueue();
  const sentAfter = await fsp.readFile(client.sentPath(), 'utf8');
  expect(sentAfter).toBe(sentBefore);
  client.shutdown();
});
