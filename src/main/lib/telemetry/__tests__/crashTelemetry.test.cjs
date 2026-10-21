/**
 * crashTelemetry.test.cjs — unit tests for the electron-free crash-report tap
 * crashDiagnostics.cjs's render-process-gone / child-process-gone hooks and
 * unclean-shutdown postmortem call into.
 *
 * Run: timeout 120 npx vitest run src/main/lib/telemetry/__tests__/crashTelemetry.test.cjs
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
  process.env.SM_TELEMETRY_SPOOL = path.join(dir, '.claude', 'session-manager');
  return dir;
}

function freshClient() {
  for (const p of ['../telemetryClient.cjs', '../../../config.cjs', '../telemetrySettings.cjs', '../../machineProfile.cjs']) {
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

test('classifyUncleanShutdown: main-hang when the last loop stall was >= 10 s', () => {
  const { classifyUncleanShutdown } = require('../crashTelemetry.cjs');
  // The 2026-10-19 19:14 PDT sample: 972 MB total, far below memory pressure.
  expect(classifyUncleanShutdown({ lastLoopDelayMaxMs: 23521.7, lastTotalMb: 972, silentGapSec: 360 })).toBe('main-hang');
  expect(classifyUncleanShutdown({ lastLoopDelayMaxMs: 10000, lastTotalMb: 100 })).toBe('main-hang');
  // Hang wins over memory pressure.
  expect(classifyUncleanShutdown({ lastLoopDelayMaxMs: 12000, lastTotalMb: 4000 })).toBe('main-hang');
});

test('classifyUncleanShutdown: memory-pressure when total >= 3000 MB and no hang', () => {
  const { classifyUncleanShutdown } = require('../crashTelemetry.cjs');
  expect(classifyUncleanShutdown({ lastLoopDelayMaxMs: 9999, lastTotalMb: 3000 })).toBe('memory-pressure');
  expect(classifyUncleanShutdown({ lastTotalMb: 5000 })).toBe('memory-pressure');
});

test('classifyUncleanShutdown: unknown otherwise, and non-number inputs never throw', () => {
  const { classifyUncleanShutdown } = require('../crashTelemetry.cjs');
  expect(classifyUncleanShutdown({ lastLoopDelayMaxMs: 50, lastTotalMb: 900, silentGapSec: 5 })).toBe('unknown');
  expect(classifyUncleanShutdown({})).toBe('unknown');
  expect(classifyUncleanShutdown()).toBe('unknown');
  expect(classifyUncleanShutdown({ lastLoopDelayMaxMs: '23000', lastTotalMb: null, silentGapSec: NaN })).toBe('unknown');
});

test('reportChildProcessGone: Utility Network Service (non-oom) is a warn log line, not an error', () => {
  const { reportChildProcessGone } = require('../crashTelemetry.cjs');
  const calls = { log: [], err: [] };
  const deps = { telemetryClient: { logLine: (a) => calls.log.push(a), reportError: (a) => calls.err.push(a) } };
  reportChildProcessGone({
    details: { type: 'Utility', name: 'Network Service', reason: 'crashed', exitCode: -1 },
    lastTotalMb: 900,
    deps,
  });
  expect(calls.err).toEqual([]);
  expect(calls.log).toEqual([{
    level: 'warn',
    msg: 'crash.child-restartable',
    fields: { type: 'Utility', name: 'Network Service', reason: 'crashed', exitCode: -1, lastTotalMb: 900 },
  }]);
  // serviceName is accepted as the name too.
  reportChildProcessGone({ details: { type: 'Utility', serviceName: 'Network Service', reason: 'killed' }, deps });
  expect(calls.log).toHaveLength(2);
});

test('reportChildProcessGone: everything else (GPU, oom, other utility) goes through reportCrash', () => {
  const { reportChildProcessGone } = require('../crashTelemetry.cjs');
  const calls = { log: [], err: [] };
  const deps = { telemetryClient: { logLine: (a) => calls.log.push(a), reportError: (a) => calls.err.push(a) } };
  reportChildProcessGone({ details: { type: 'GPU', reason: 'crashed', exitCode: 9 }, lastTotalMb: 1200, deps });
  reportChildProcessGone({ details: { type: 'Utility', name: 'Network Service', reason: 'oom' }, deps });
  reportChildProcessGone({ details: { type: 'Utility', name: 'Audio Service', reason: 'crashed' }, deps });
  reportChildProcessGone({ details: {}, deps });
  expect(calls.log).toEqual([]);
  expect(calls.err).toHaveLength(4);
  expect(calls.err[0]).toEqual({
    name: 'crash.crashed',
    msg: 'crashed',
    context: { type: 'GPU', name: undefined, exitCode: 9, lastTotalMb: 1200 },
  });
  expect(calls.err[1].name).toBe('crash.oom');
  expect(calls.err[3].name).toBe('crash.unknown');
});

test('reportChildProcessGone never throws', () => {
  const { reportChildProcessGone } = require('../crashTelemetry.cjs');
  const throwing = { logLine: () => { throw new Error('boom'); }, reportError: () => { throw new Error('boom'); } };
  expect(() => reportChildProcessGone({ details: { type: 'Utility', name: 'Network Service', reason: 'crashed' }, deps: { telemetryClient: throwing } })).not.toThrow();
  expect(() => reportChildProcessGone({ details: { type: 'GPU' }, deps: { telemetryClient: throwing } })).not.toThrow();
  expect(() => reportChildProcessGone()).not.toThrow();
});

test('reportCrash never throws even when the injected telemetryClient throws', () => {
  const throwingClient = { reportError: () => { throw new Error('telemetry boom'); } };
  expect(() => reportCrash({ reason: 'oom', meta: {}, deps: { telemetryClient: throwingClient } })).not.toThrow();
});
