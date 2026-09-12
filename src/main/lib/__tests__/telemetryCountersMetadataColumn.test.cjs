/**
 * telemetryCountersMetadataColumn.test.cjs — the event channel has no version
 * column (telemetryClient.test.cjs's "funnel_events has no version column"
 * test covers the generic case); this asserts the same survives specifically
 * for each of the four counter events this PRD adds, once serialized the way
 * the /api/telemetry/event route persists it into `metadata`.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/telemetryCountersMetadataColumn.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const counters = require('../telemetryCounters.cjs');

const tmpDirs = [];
let originalHome;
let originalSmTelemetrySpool;

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalSmTelemetrySpool === undefined) delete process.env.SM_TELEMETRY_SPOOL; else process.env.SM_TELEMETRY_SPOOL = originalSmTelemetrySpool;
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkHome() {
  originalHome = process.env.HOME;
  originalSmTelemetrySpool = process.env.SM_TELEMETRY_SPOOL;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-telemetry-counters-home-'));
  tmpDirs.push(dir);
  process.env.HOME = dir;
  // Explicit opt-in: overrides the test-environment no-op guard so this
  // suite's real telemetryClient calls actually persist into an isolated dir.
  process.env.SM_TELEMETRY_SPOOL = path.join(dir, '.config', 'session-manager');
  return dir;
}

function freshClient() {
  for (const p of ['../telemetryClient.cjs', '../../config.cjs', '../telemetrySettings.cjs', '../machineProfile.cjs']) {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  }
  const client = require('../telemetryClient.cjs');
  client._setMachineProfileBuilder(async () => ({
    appVersion: '0.83.0', platform: 'linux', arch: 'x64', machineDigest: 'deadbeefcafe',
  }));
  return client;
}

async function readQueueLines(client) {
  const fs = require('node:fs/promises');
  try {
    const raw = await fs.readFile(client.queuePath(), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function asPersistedMetadata(rec) {
  // Mirrors exactly what the deployed /api/telemetry/event INSERT persists
  // into the `metadata` column (see telemetryClient.test.cjs).
  return JSON.parse(JSON.stringify(rec.wire.props));
}

test('every counter event still yields appVersion + machineDigest once persisted into metadata', async () => {
  await mkHome();
  const client = freshClient();
  const deps = { telemetryClient: client };

  counters.trackAppLaunch({ installChannel: 'npx', appVersion: '0.83.0' }, deps);
  counters.trackSessionOpen(deps);
  counters.trackEpicCreate(deps);
  counters.trackSchedulerJobFinish({ status: 'completed' }, deps);

  // track() ingress does real (albeit fast) fs I/O before it resolves; wait a
  // tick since the counter functions fire it without awaiting the promise.
  await new Promise((r) => setTimeout(r, 50));

  const recs = await readQueueLines(client);
  expect(recs.length).toBe(4);
  for (const rec of recs) {
    const meta = asPersistedMetadata(rec);
    expect(meta.appVersion).toBe('0.83.0');
    expect(meta.machineDigest).toBe('deadbeefcafe');
  }
  client.shutdown();
});
