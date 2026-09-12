/**
 * opsErrorLogTelemetryTap.test.cjs — unit tests for appendError()'s telemetry
 * mirror. Kept separate from opsErrorLog.test.cjs (whose pre-existing tests
 * stay unmodified in intent) since this is new behavior this PRD adds.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/opsErrorLogTelemetryTap.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const opsErrorLog = require('../lib/opsErrorLog.cjs');

const tmpDirs = [];
let originalHome;
let originalSmTelemetrySpool;

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalSmTelemetrySpool === undefined) delete process.env.SM_TELEMETRY_SPOOL; else process.env.SM_TELEMETRY_SPOOL = originalSmTelemetrySpool;
  const telemetryPath = require.resolve('../lib/telemetryClient.cjs');
  delete require.cache[telemetryPath];
  const activeSessionsPath = require.resolve('../../../scripts/lib/activeSessions.cjs');
  delete require.cache[activeSessionsPath];
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

function mkTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-opslog-telemetry-'));
  tmpDirs.push(dir);
  return dir;
}

function readLines(cwd) {
  const file = opsErrorLog.todayFile(cwd);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function stubTelemetryClient(exportsObj) {
  const telemetryPath = require.resolve('../lib/telemetryClient.cjs');
  require.cache[telemetryPath] = { id: telemetryPath, filename: telemetryPath, loaded: true, exports: exportsObj };
}

// ─── AFTER local write, never blocks it ──────────────────────────────────

test('a throwing telemetry stub never prevents or corrupts the local JSONL write', () => {
  const cwd = mkTmpProject();
  stubTelemetryClient({
    reportError: () => { throw new Error('telemetry boom'); },
    logLine: () => { throw new Error('telemetry boom'); },
  });

  expect(() => opsErrorLog.appendError({ cwd, scope: 'pty', message: 'boom happened' })).not.toThrow();

  const lines = readLines(cwd);
  expect(lines.length).toBe(1);
  expect(lines[0].message).toBe('boom happened');
});

test('level "warn" routes to telemetryClient.logLine, default "error" routes to reportError', () => {
  const cwd = mkTmpProject();
  const reportErrorCalls = [];
  const logLineCalls = [];
  stubTelemetryClient({
    reportError: (o) => reportErrorCalls.push(o),
    logLine: (o) => logLineCalls.push(o),
  });

  opsErrorLog.appendError({ cwd, scope: 'chatRunner', level: 'warn', message: 'careful' });
  expect(logLineCalls).toHaveLength(1);
  expect(reportErrorCalls).toHaveLength(0);

  opsErrorLog.appendError({ cwd, scope: 'chatRunner', message: 'broke' });
  expect(reportErrorCalls).toHaveLength(1);
});

// ─── ephemeral cwd: local refused, telemetry still fires ─────────────────

test('an ephemeral cwd yields zero local lines but one telemetry record, with a normalized projectHash', () => {
  const { KIND_CONFIG } = require('../lib/gitWorktree.cjs');
  const worktreeCwd = path.join(KIND_CONFIG.epic.root, 'fakehash', 'fake-epic-id');
  const realRoot = '/home/bilko/Projects/real-project';

  const activeSessionsPath = require.resolve('../../../scripts/lib/activeSessions.cjs');
  const original = require('../../../scripts/lib/activeSessions.cjs');
  require.cache[activeSessionsPath] = {
    id: activeSessionsPath,
    filename: activeSessionsPath,
    loaded: true,
    exports: { ...original, projectRootOf: (p) => (p === worktreeCwd ? realRoot : p) },
  };

  const reportErrorCalls = [];
  stubTelemetryClient({ reportError: (o) => reportErrorCalls.push(o), logLine: () => {} });

  opsErrorLog.appendError({ cwd: worktreeCwd, scope: 'chatRunner', message: 'worktree err' });

  expect(fs.existsSync(opsErrorLog.todayFile(worktreeCwd))).toBe(false);
  expect(reportErrorCalls).toHaveLength(1);
  expect(reportErrorCalls[0].context.cwd).toBe(realRoot);
  expect(reportErrorCalls[0].context.cwd).not.toBe(worktreeCwd);
});

// ─── PII: no prompt text, no absolute path ────────────────────────────────

test('a realistic error with an absolute path and a prompt-like string never reaches the telemetry payload verbatim', async () => {
  originalHome = process.env.HOME;
  originalSmTelemetrySpool = process.env.SM_TELEMETRY_SPOOL;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-opslog-telemetry-home-'));
  tmpDirs.push(home);
  process.env.HOME = home;
  // Explicit opt-in: overrides the test-environment no-op guard so this
  // test's real telemetryClient call actually persists into an isolated dir.
  process.env.SM_TELEMETRY_SPOOL = path.join(home, '.config', 'session-manager');

  for (const p of ['../lib/telemetryClient.cjs', '../config.cjs', '../lib/telemetrySettings.cjs', '../lib/machineProfile.cjs']) {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  }
  const client = require('../lib/telemetryClient.cjs');
  client._setMachineProfileBuilder(async () => ({
    appVersion: '0.83.0', platform: 'linux', arch: 'x64', machineDigest: 'deadbeefcafe',
  }));

  const cwd = mkTmpProject();
  const absPath = `${home}/Projects/super-secret-client/src/main/index.cjs`;
  const promptLike = 'write me a function that deletes all files matching *.secret and email me the results';
  opsErrorLog.appendError({
    cwd,
    scope: 'chatRunner',
    message: `run failed while processing "${promptLike}" at ${absPath}`,
  });

  await new Promise((r) => setTimeout(r, 50));

  const raw = await fsp.readFile(client.queuePath(), 'utf8');
  expect(raw).not.toContain(home);
  expect(raw).not.toContain(absPath);
  expect(raw).not.toContain(promptLike);
  client.shutdown();
});
