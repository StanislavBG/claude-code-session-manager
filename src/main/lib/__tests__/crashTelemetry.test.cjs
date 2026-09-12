/**
 * crashTelemetry.test.cjs — unit tests for the electron-free crash-report tap
 * crashDiagnostics.cjs's render-process-gone / child-process-gone hooks and
 * unclean-shutdown postmortem call into.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/crashTelemetry.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { reportCrash } = require('../crashTelemetry.cjs');

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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-crash-telemetry-home-'));
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

test('reportCrash names the record "crash.<reason>"', async () => {
  await mkHome();
  const client = freshClient();
  await reportCrash({ reason: 'oom', meta: { type: 'render' }, deps: { telemetryClient: client } });
  const [rec] = await readQueueLines(client);
  expect(rec.wire.name).toBe('crash.oom');
  client.shutdown();
});

test('a crash record carries the full attribution stamp: appVersion, platform, arch, machineDigest', async () => {
  await mkHome();
  const client = freshClient();
  await reportCrash({ reason: 'killed', meta: { type: 'child', name: 'gpu' }, deps: { telemetryClient: client } });
  const [rec] = await readQueueLines(client);
  expect(rec.wire.version).toBe('0.83.0');
  expect(rec.wire.context.platform).toBeTruthy();
  expect(rec.wire.context.arch).toBeTruthy();
  expect(rec.wire.context.machineDigest).toBeTruthy();
  client.shutdown();
});

test('the unclean-shutdown postmortem is reported as crash.unclean-shutdown with the last memory sample', async () => {
  await mkHome();
  const client = freshClient();
  await reportCrash({
    reason: 'unclean-shutdown',
    meta: { lastTotalMb: 1800, lastMainRssMb: 900, lastTop: ['renderer:900MB'] },
    deps: { telemetryClient: client },
  });
  const [rec] = await readQueueLines(client);
  expect(rec.wire.name).toBe('crash.unclean-shutdown');
  expect(rec.wire.context.lastTotalMb).toBe(1800);
  client.shutdown();
});

test('reportCrash never throws even when the injected telemetryClient throws', () => {
  const throwingClient = { reportError: () => { throw new Error('telemetry boom'); } };
  expect(() => reportCrash({ reason: 'oom', meta: {}, deps: { telemetryClient: throwingClient } })).not.toThrow();
});
