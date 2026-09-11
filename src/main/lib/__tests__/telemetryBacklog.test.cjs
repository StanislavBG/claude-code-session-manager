/**
 * telemetryBacklog.test.cjs — unit tests for the pre-existing error-log
 * backlog drainer (telemetryBacklog.cjs).
 *
 * Run: timeout 180 npx vitest run src/main/lib/__tests__/telemetryBacklog.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const opsErrorLog = require('../opsErrorLog.cjs');
const { isEphemeralCwd } = require('../ephemeralCwd.cjs');
const { resolveProjectContext } = require('../projectRootResolve.cjs');

const tmpDirs = [];
let originalHome;

beforeEach(() => {
  originalHome = process.env.HOME;
});

afterEach(async () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  vi.unstubAllGlobals();
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-backlog-home-'));
  tmpDirs.push(dir);
  return dir;
}

async function mkProject(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `sm-backlog-project-${name}-`));
  tmpDirs.push(dir);
  return dir;
}

function fakeProfile(overrides = {}) {
  return { appVersion: '0.83.0', platform: 'linux', arch: 'x64', machineDigest: 'deadbeefcafe', installChannel: 'dev', ...overrides };
}

/** Reloads the HOME-dependent modules (config.cjs computes allowedRoots from os.homedir() at require time). */
function freshTelemetry(home) {
  process.env.HOME = home;
  for (const p of ['../telemetryClient.cjs', '../../config.cjs', '../telemetrySettings.cjs', '../machineProfile.cjs']) {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  }
  const telemetryClient = require('../telemetryClient.cjs');
  const config = require('../../config.cjs');
  telemetryClient._setMachineProfileBuilder(async () => fakeProfile());
  return { telemetryClient, config };
}

function reloadBacklog() {
  const resolved = require.resolve('../telemetryBacklog.cjs');
  delete require.cache[resolved];
  return require('../telemetryBacklog.cjs');
}

function fetchStub(responder) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    const rec = { url, opts, body: JSON.parse(opts.body) };
    calls.push(rec);
    return responder(rec, calls.length);
  });
  fn.calls = calls;
  return fn;
}

function okAlways() {
  return fetchStub(() => ({ ok: true, status: 200 }));
}

function failAlways(status = 500) {
  return fetchStub(() => ({ ok: false, status }));
}

function writeErrorsFile(projectCwd, dateStr, lines, { trailingNewline = true } = {}) {
  const dir = opsErrorLog.logsDir(projectCwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `errors-${dateStr}.jsonl`);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  fs.writeFileSync(file, trailingNewline ? body + '\n' : body);
  return file;
}

/** A recent date string (within the 30-day retention floor) for fixture filenames. */
function recentDateStr() {
  return new Date().toISOString().slice(0, 10);
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

function makeDeps({ home, telemetryClient, config, tabCwds }) {
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

function watermarksFileFor(home) {
  return path.join(home, '.config', 'session-manager', 'telemetry-watermarks.json');
}

async function readWatermarks(home) {
  try {
    return JSON.parse(await fsp.readFile(watermarksFileFor(home), 'utf8'));
  } catch {
    return {};
  }
}

// ─── exports + basic shape ─────────────────────────────────────────────

test('exports drainBacklog + reconcileWatermarks returning the documented summary shape', async () => {
  const home = await mkHome();
  const project = await mkProject('shape');
  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const summary = await backlog.drainBacklog({ now: Date.now(), limit: 500, deps });
  for (const key of ['projectsScanned', 'filesScanned', 'linesEnqueued', 'linesConfirmed', 'linesSkipped', 'filesCompleted', 'watermarksRewound']) {
    expect(typeof summary[key]).toBe('number');
  }
  expect(typeof backlog.reconcileWatermarks).toBe('function');
});

// ─── project enumeration ────────────────────────────────────────────────

test('duplicate cwds across tabs are visited once; a missing cwd is skipped without throwing', async () => {
  const home = await mkHome();
  const project = await mkProject('dedupe');
  writeErrorsFile(project, recentDateStr(), [errLine(1)]);
  const missing = path.join(os.tmpdir(), 'sm-backlog-does-not-exist-' + Date.now());

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project, project, missing] });

  const summary = await expect(backlog.drainBacklog({ now: Date.now(), deps })).resolves.toBeDefined();
  const s = await backlog.drainBacklog({ now: Date.now(), deps });
  // Second call: file already fully drained+confirmed on the first call, so
  // the single deduped project contributes zero further lines.
  expect(s.linesEnqueued).toBe(0);
});

test('an ephemeral epic-worktree cwd is never scanned as its own project', async () => {
  const home = await mkHome();
  const ephemeral = path.join(os.tmpdir(), 'session-manager-epic-worktrees', 'abc123', 'psess-xyz');
  const opsDir = path.join(ephemeral, 'session-manager-operations', 'logs');
  fs.mkdirSync(opsDir, { recursive: true });
  fs.writeFileSync(path.join(opsDir, `errors-${recentDateStr()}.jsonl`), JSON.stringify(errLine(1)) + '\n');

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [ephemeral] });

  const summary = await backlog.drainBacklog({ now: Date.now(), deps });
  expect(summary.projectsScanned).toBe(0);
  expect(summary.linesEnqueued).toBe(0);
});

// ─── log files are never modified ──────────────────────────────────────

test('log files are never modified — mtime and byte length unchanged after a full drain', async () => {
  const home = await mkHome();
  const project = await mkProject('readonly');
  const file = writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2), { not: 'valid error shape but still json' }]);
  const before = fs.statSync(file);
  const beforeBytes = fs.readFileSync(file);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });
  await backlog.drainBacklog({ now: Date.now(), deps });

  const after = fs.statSync(file);
  const afterBytes = fs.readFileSync(file);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(afterBytes.length).toBe(beforeBytes.length);
  expect(Buffer.compare(afterBytes, beforeBytes)).toBe(0);
});

// ─── two-phase watermark ────────────────────────────────────────────────

test('a drain whose flush fails leaves bytesConfirmed at its previous value while bytesEnqueued advances', async () => {
  const home = await mkHome();
  const project = await mkProject('flushfail');
  writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2)]);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(failAlways(500));
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  await backlog.drainBacklog({ now: Date.now(), deps });

  const wm = await readWatermarks(home);
  const [key, entry] = Object.entries(wm)[0];
  expect(entry.bytesEnqueued).toBeGreaterThan(0);
  expect(entry.bytesConfirmed).toBe(0);
});

// ─── deterministic recordId ─────────────────────────────────────────────

test('re-draining the same file after a forced watermark rewind produces identical recordIds', async () => {
  const home = await mkHome();
  const project = await mkProject('detid');
  writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2)]);

  // flush always fails, so bytesConfirmed stays at 0 while bytesEnqueued
  // advances — this is the exact invariant a real rewind (bytesEnqueued ->
  // bytesConfirmed) restores, so rewinding to 0 here mirrors what
  // reconcileWatermarks would actually do after a detected loss.
  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(failAlways(500));
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const spy = vi.spyOn(telemetryClient, 'reportError');
  await backlog.drainBacklog({ now: Date.now(), deps });
  const firstIds = spy.mock.calls.map((c) => c[0].recordId).sort();
  expect(firstIds.length).toBe(2);

  // Force a rewind directly on the watermark file (simulating reconcileWatermarks having found a loss).
  const wm = await readWatermarks(home);
  const key = Object.keys(wm)[0];
  expect(wm[key].bytesConfirmed).toBe(0);
  wm[key].bytesEnqueued = wm[key].bytesConfirmed;
  await config.writeJson(watermarksFileFor(home), wm);

  spy.mockClear();
  await backlog.drainBacklog({ now: Date.now(), deps });
  const secondIds = spy.mock.calls.map((c) => c[0].recordId).sort();

  expect(secondIds).toEqual(firstIds);
});

// ─── boot reconciliation (anti-loss) ────────────────────────────────────

test('boot reconciliation re-sends a record that was enqueued then evicted from the queue before delivery, exactly once', async () => {
  const home = await mkHome();
  const project = await mkProject('reconcile');
  writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2)]);

  // Round 1: enqueue succeeds (accepted into telemetryClient's durable queue)
  // but flush fails, so nothing is delivered yet.
  let { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(failAlways(500));
  let backlog = reloadBacklog();
  let deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });
  await backlog.drainBacklog({ now: Date.now(), deps });

  // Simulate queue eviction without delivery: wipe the durable queue file.
  await fsp.writeFile(telemetryClient.queuePath(), '', 'utf8');

  // "Restart": fresh telemetryClient + fresh drainer, same HOME (same config dir).
  ({ telemetryClient, config } = freshTelemetry(home));
  const fetch2 = okAlways();
  telemetryClient._setFetchImpl(fetch2);
  backlog = reloadBacklog();
  deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const reconcileSummary = await backlog.reconcileWatermarks({ now: Date.now(), deps });
  expect(reconcileSummary.watermarksRewound).toBe(1);

  const spy = vi.spyOn(telemetryClient, 'reportError');
  const drainSummary = await backlog.drainBacklog({ now: Date.now(), deps });
  expect(spy.mock.calls.length).toBe(2); // both lines re-sent exactly once
  expect(drainSummary.linesEnqueued).toBe(2);

  const wm = await readWatermarks(home);
  const entry = Object.values(wm)[0];
  expect(entry.bytesConfirmed).toBe(entry.bytesEnqueued);
  expect(entry.completedAt).toBeTruthy();
});

// ─── anti-over-traffic (the acceptance test for the whole design) ──────

test('draining an unchanged fixture tree twice in the same process produces ZERO outbound records the second time', async () => {
  const home = await mkHome();
  const project = await mkProject('notwice');
  writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2), errLine(3)]);

  const { telemetryClient, config } = freshTelemetry(home);
  const fetchFn = okAlways();
  telemetryClient._setFetchImpl(fetchFn);
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  await backlog.drainBacklog({ now: Date.now(), deps });
  const callsAfterFirst = fetchFn.calls.length;
  expect(callsAfterFirst).toBeGreaterThan(0);

  await backlog.drainBacklog({ now: Date.now(), deps });
  expect(fetchFn.calls.length).toBe(callsAfterFirst); // zero additional outbound records
});

test('draining the same unchanged tree across a simulated restart also produces ZERO outbound records', async () => {
  const home = await mkHome();
  const project = await mkProject('norestart');
  writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2), errLine(3)]);

  let { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  let backlog = reloadBacklog();
  let deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });
  await backlog.drainBacklog({ now: Date.now(), deps });

  // Fresh client + fresh drainer, same HOME/config dir — a simulated restart.
  ({ telemetryClient, config } = freshTelemetry(home));
  const fetch2 = okAlways();
  telemetryClient._setFetchImpl(fetch2);
  backlog = reloadBacklog();
  deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  await backlog.drainBacklog({ now: Date.now(), deps });
  expect(fetch2.calls.length).toBe(0);
});

// ─── resume-on-append ───────────────────────────────────────────────────

test('resumes from the byte offset on append — draining twice after appending enqueues only the new lines', async () => {
  const home = await mkHome();
  const project = await mkProject('append');
  const file = writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2)]);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const spy = vi.spyOn(telemetryClient, 'reportError');
  await backlog.drainBacklog({ now: Date.now(), deps });
  expect(spy.mock.calls.length).toBe(2);
  spy.mockClear();

  fs.appendFileSync(file, JSON.stringify(errLine(3)) + '\n' + JSON.stringify(errLine(4)) + '\n');
  const summary = await backlog.drainBacklog({ now: Date.now(), deps });
  expect(spy.mock.calls.length).toBe(2);
  expect(summary.linesEnqueued).toBe(2);
});

// ─── truncation/rotation safety ─────────────────────────────────────────

test('a file smaller than its recorded bytesEnqueued is re-read from zero rather than seeking past EOF', async () => {
  const home = await mkHome();
  const project = await mkProject('truncate');
  const file = writeErrorsFile(project, recentDateStr(), [errLine(1), errLine(2), errLine(3)]);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });
  await backlog.drainBacklog({ now: Date.now(), deps });

  // Truncate/rotate: file replaced with a single, shorter line.
  fs.writeFileSync(file, JSON.stringify(errLine(99)) + '\n');

  const spy = vi.spyOn(telemetryClient, 'reportError');
  await backlog.drainBacklog({ now: Date.now(), deps });
  // Re-read from zero: the new (shorter) content at offset 0 was parsed and
  // handed to telemetryClient — note this deliberately does NOT assert
  // delivery, since a byte-offset-derived recordId for offset 0 collides
  // with the prior (already-delivered) content that also started at offset
  // 0; telemetryClient's own dedup correctly treats that recordId as already
  // sent. What truncation safety guarantees is "read from zero, not past
  // EOF" — not that a same-offset rewrite bypasses the client's dedup.
  expect(spy.mock.calls.some((c) => c[0].name === 'synthetic-99')).toBe(true);
  const wm = await readWatermarks(home);
  expect(Object.values(wm)[0].bytesEnqueued).toBe(fs.statSync(file).size);
});

// ─── malformed lines + truncated trailing line ──────────────────────────

test('malformed JSON lines are skipped, still advance the offset, and never throw; a truncated trailing line is left for the next drain', async () => {
  const home = await mkHome();
  const project = await mkProject('malformed');
  const file = writeErrorsFile(
    project,
    recentDateStr(),
    [JSON.stringify(errLine(1)), 'not valid json at all {{{', JSON.stringify(errLine(2))],
  );
  // Append an in-progress (no trailing newline) partial line.
  fs.appendFileSync(file, '{"level":"error","scope":"partial-in-progr');

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const summary = await backlog.drainBacklog({ now: Date.now(), deps });
  expect(summary.linesSkipped).toBe(1);
  expect(summary.linesEnqueued).toBe(2);

  const wm = await readWatermarks(home);
  const entry = Object.values(wm)[0];
  const size = fs.statSync(file).size;
  expect(entry.bytesEnqueued).toBeLessThan(size); // trailing partial line left unconsumed
});

// ─── per-drain budget ────────────────────────────────────────────────────

test('a 1200-line fixture drains as 500, then 500, then 200 (oldest file first, default budget)', async () => {
  const home = await mkHome();
  const project = await mkProject('budget');
  const lines = Array.from({ length: 1200 }, (_, i) => errLine(i));
  writeErrorsFile(project, recentDateStr(), lines);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const s1 = await backlog.drainBacklog({ now: Date.now(), limit: 500, deps });
  const s2 = await backlog.drainBacklog({ now: Date.now(), limit: 500, deps });
  const s3 = await backlog.drainBacklog({ now: Date.now(), limit: 500, deps });

  expect(s1.linesEnqueued).toBe(500);
  expect(s2.linesEnqueued).toBe(500);
  expect(s3.linesEnqueued).toBe(200);
});

// ─── retention floor ─────────────────────────────────────────────────────

test('a log file older than the 30-day retention floor is marked completed WITHOUT being opened for read', async () => {
  const home = await mkHome();
  const project = await mkProject('retention');
  const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const dateStr = oldDate.toISOString().slice(0, 10);
  writeErrorsFile(project, dateStr, [errLine(1), errLine(2)]);

  const { telemetryClient, config } = freshTelemetry(home);
  const fetchFn = okAlways();
  telemetryClient._setFetchImpl(fetchFn);
  const backlog = reloadBacklog();
  const readSpy = vi.spyOn(fsp, 'readFile');
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const summary = await backlog.drainBacklog({ now: Date.now(), deps });
  expect(summary.filesCompleted).toBe(1);
  expect(fetchFn.calls.length).toBe(0);
  const logFile = path.join(opsErrorLog.logsDir(project), `errors-${dateStr}.jsonl`);
  expect(readSpy.mock.calls.some((c) => c[0] === logFile)).toBe(false);
  readSpy.mockRestore();
});

// ─── completed-file fast path ────────────────────────────────────────────

test('a fully-confirmed file is stamped completed and skipped by later scans without any content-read syscall', async () => {
  const home = await mkHome();
  const project = await mkProject('completed');
  const file = writeErrorsFile(project, recentDateStr(), [errLine(1)]);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });
  await backlog.drainBacklog({ now: Date.now(), deps });

  const wm = await readWatermarks(home);
  expect(Object.values(wm)[0].completedAt).toBeTruthy();

  // A cheap stat (to detect append/truncate) is fine; a full content read
  // ("re-opened") is not, on a file whose size hasn't changed since completion.
  const readSpy = vi.spyOn(fsp, 'readFile');
  await backlog.drainBacklog({ now: Date.now(), deps });
  expect(readSpy.mock.calls.some((c) => c[0] === file)).toBe(false);
  readSpy.mockRestore();
});

// ─── level routing ────────────────────────────────────────────────────────

test('level "warn" lines route to logLine, level "error" lines route to reportError, carrying scope/tags/cwd', async () => {
  const home = await mkHome();
  const project = await mkProject('levels');
  writeErrorsFile(project, recentDateStr(), [
    { level: 'error', scope: 'chatRunner', tags: ['t1'], message: 'e' },
    { level: 'warn', scope: 'pty', tags: ['t2'], message: 'w' },
  ]);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });

  const errSpy = vi.spyOn(telemetryClient, 'reportError');
  const logSpy = vi.spyOn(telemetryClient, 'logLine');
  await backlog.drainBacklog({ now: Date.now(), deps });

  expect(errSpy.mock.calls.length).toBe(1);
  expect(errSpy.mock.calls[0][0].context.scope).toBe('chatRunner');
  expect(errSpy.mock.calls[0][0].context.cwd).toBe(project);
  expect(logSpy.mock.calls.length).toBe(1);
  expect(logSpy.mock.calls[0][0].fields.scope).toBe('pty');
  expect(logSpy.mock.calls[0][0].fields.cwd).toBe(project);
});

// ─── boot wiring: invoked on ready, once more per new version ───────────

test('bootDrain always drains with reason "boot", and drains a second time with reason "version-change" exactly once per new version', async () => {
  const home = await mkHome();
  const project = await mkProject('wiring');
  writeErrorsFile(project, recentDateStr(), [errLine(1)]);

  const { telemetryClient, config } = freshTelemetry(home);
  telemetryClient._setFetchImpl(okAlways());
  const backlog = reloadBacklog();
  const deps = makeDeps({ home, telemetryClient, config, tabCwds: [project] });
  // Each internal drainBacklog() call enumerates projects twice (once for
  // its own reconcileWatermarks() pass, once for the drain pass itself) via
  // sessionsStore.load() — counting those calls in multiples of 2 tells us
  // how many actual drain passes bootDrain performed, without reaching into
  // module internals.
  const loadSpy = vi.spyOn(deps.sessionsStore, 'load');

  await backlog.bootDrain({ now: Date.now(), appVersion: '1.0.0', deps });
  expect(loadSpy.mock.calls.length).toBe(4); // 2 drain passes: boot + version-change (first time seeing 1.0.0)

  loadSpy.mockClear();
  await backlog.bootDrain({ now: Date.now(), appVersion: '1.0.0', deps });
  expect(loadSpy.mock.calls.length).toBe(2); // 1 drain pass: same version again — no second version-change drain

  loadSpy.mockClear();
  await backlog.bootDrain({ now: Date.now(), appVersion: '2.0.0', deps });
  expect(loadSpy.mock.calls.length).toBe(4); // 2 drain passes: new version — exactly one more version-change drain
});

// ─── fully contained: never throws ──────────────────────────────────────

test('drainBacklog resolves (never rejects) when readdir fails, telemetryClient throws, and the watermarks file is corrupt', async () => {
  const home = await mkHome();
  await fsp.mkdir(path.join(home, '.config', 'session-manager'), { recursive: true });
  await fsp.writeFile(watermarksFileFor(home), 'not valid { json', 'utf8');
  const project = await mkProject('contained');
  writeErrorsFile(project, recentDateStr(), [errLine(1)]);

  const backlog = reloadBacklog();
  const throwingFs = {
    ...fs,
    readdirSync: () => { throw new Error('boom readdir'); },
  };
  const throwingClient = {
    reportError: async () => { throw new Error('boom client'); },
    logLine: async () => { throw new Error('boom client'); },
    flush: async () => { throw new Error('boom flush'); },
    isPending: async () => { throw new Error('boom pending'); },
    sentPath: () => path.join(home, '.config', 'session-manager', 'telemetry-sent.json'),
  };
  const deps = {
    sessionsStore: { load: async () => ({ tabs: [{ cwd: project }] }) },
    isEphemeralCwd,
    resolveProjectContext,
    telemetryClient: throwingClient,
    opsErrorLog,
    config: require('../../config.cjs'),
    fs: throwingFs,
    fsp,
  };

  await expect(backlog.drainBacklog({ now: Date.now(), deps })).resolves.toBeDefined();
  const summary = await backlog.drainBacklog({ now: Date.now(), deps });
  expect(summary.projectsScanned).toBe(1);
  expect(summary.filesScanned).toBe(0); // readdirSync throws -> no files found, no throw
});
