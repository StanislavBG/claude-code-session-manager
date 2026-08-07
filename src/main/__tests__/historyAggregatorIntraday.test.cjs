/**
 * historyAggregatorIntraday.test.cjs — unit tests for
 * historyAggregator.cjs's refreshIntradayToday() fast walk (PRD: make the
 * periodic intraday refresh proportional to files actually modified today
 * instead of stat-ing every jsonl file on every tick).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/historyAggregatorIntraday.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let historyRollup;
let historyAggregator;

function encodeCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

function projectsDirFor(tmp) {
  return path.join(tmp, '.claude', 'projects');
}

function writeTranscript(projectCwd, sessionId, lines, mtime) {
  const encoded = encodeCwd(projectCwd);
  const dir = path.join(projectsDirFor(tmpHome), encoded);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function userLine(ts) {
  return { role: 'user', ts };
}

function assistantLine(ts, model, tokens = {}) {
  return {
    ts,
    message: {
      role: 'assistant',
      model,
      usage: {
        input_tokens: tokens.in ?? 10,
        output_tokens: tokens.out ?? 5,
        cache_read_input_tokens: tokens.cacheR ?? 0,
        cache_creation_input_tokens: tokens.cacheC ?? 0,
      },
    },
  };
}

// Same top-level-const-baking concern as historyRollup.test.cjs — see its
// comment. PROJECTS_DIR, ROLLUP_PATH, and config.cjs's allowedRoots are all
// computed from os.homedir() at first require.
const MODULES_TO_RELOAD = [
  '../lib/historyRollup.cjs',
  '../historyAggregator.cjs',
  '../config.cjs',
];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'history-intraday-test-'));
  process.env.HOME = tmpHome;
  purgeRequireCache();
  historyRollup = require('../lib/historyRollup.cjs');
  historyAggregator = require('../historyAggregator.cjs');
});

afterEach(() => {
  process.env.HOME = realHome;
  purgeRequireCache();
  // tmpHome is a dedicated tmpdir (never the real ~/.claude/projects — HOME
  // is overridden above before any fixture file is written), but clean it up
  // regardless: leaked fixture dirs under a real ~/.claude/projects have
  // caused phantom-project bugs before (see CLAUDE.md's
  // knownProjectAggregate.ts section) — always delete what a test created.
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function today() {
  return new Date().toLocaleDateString('en-CA');
}

function todayAt(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

function yesterdayAt(hour) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * Ground-truth reimplementation of the ORIGINAL (pre-fix) refreshIntradayToday:
 * unconditional readdir-per-directory + sequential stat-per-file, no registry,
 * no concurrency. Kept here (not in production code) purely so tests can
 * assert the new fast-walk's output is byte-for-byte identical to what the
 * old algorithm produced for the same fixture.
 */
async function legacyRefreshIntradayToday() {
  const PROJECTS_DIR = projectsDirFor(tmpHome);
  const t = today();

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const buckets = new Map();
  for (const projEntry of projectDirs) {
    if (!projEntry.isDirectory()) continue;
    const encodedCwd = projEntry.name;
    const projectDir = path.join(PROJECTS_DIR, encodedCwd);

    let files;
    try { files = await fsp.readdir(projectDir, { withFileTypes: true }); } catch { continue; }

    for (const fileEntry of files) {
      if (!fileEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, fileEntry.name);

      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }

      const mtimeDate = new Date(stat.mtimeMs).toLocaleDateString('en-CA');
      if (mtimeDate < t) continue;

      const { result: parsed } = await historyAggregator.parseJSONL(filePath, stat);
      if (parsed.skipped) continue;
      if (parsed.sessionDate !== t) continue;

      const key = `${t}|${encodedCwd}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          date: t,
          encodedCwd,
          promptCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolCallCount: 0,
          sessionCount: 0,
        });
      }
      const b = buckets.get(key);
      b.promptCount += parsed.promptCount;
      b.inputTokens += parsed.inputTokens;
      b.outputTokens += parsed.outputTokens;
      b.toolCallCount += parsed.toolCallCount;
      b.sessionCount++;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.encodedCwd.localeCompare(b.encodedCwd));
}

/** Read back today's rollup lines as a simplified, order-stable shape for comparison. */
async function readTodayRollupSimplified() {
  const t = today();
  const map = await historyRollup.readRollup(t, t);
  const byProject = new Map();
  for (const bucket of map.values()) {
    if (bucket.projectDir === historyRollup.FINALIZED_PROJECT_ID) continue;
    const key = bucket.projectDir;
    let row = byProject.get(key);
    if (!row) {
      row = { date: t, encodedCwd: key, promptCount: 0, inputTokens: 0, outputTokens: 0, toolCallCount: 0, sessionCount: 0 };
      byProject.set(key, row);
    }
    if (bucket.modelId === historyRollup.TOTALS_MODEL_ID) {
      row.promptCount += bucket.promptCount || 0;
      row.toolCallCount += bucket.toolCallCount || 0;
      row.sessionCount += bucket.sessionCount || 0;
    } else {
      row.inputTokens += bucket.inputTokens || 0;
      row.outputTokens += bucket.outputTokens || 0;
    }
  }
  return Array.from(byProject.values()).sort((a, b) => a.encodedCwd.localeCompare(b.encodedCwd));
}

test('refreshIntradayToday output matches the old unconditional-walk algorithm for the same fixture', async () => {
  writeTranscript('/repo/alpha', 'sess-1', [
    userLine(todayAt(9).toISOString()),
    assistantLine(todayAt(9).toISOString(), 'claude-sonnet-5', { in: 100, out: 20 }),
  ], todayAt(9));
  writeTranscript('/repo/beta', 'sess-2', [
    userLine(todayAt(10).toISOString()),
    assistantLine(todayAt(10).toISOString(), 'claude-opus-5', { in: 50, out: 10 }),
  ], todayAt(10));
  // An old, untouched-today file mixed in — must be excluded from both.
  writeTranscript('/repo/gamma', 'sess-3', [
    userLine(yesterdayAt(9).toISOString()),
  ], yesterdayAt(9));

  const expected = await legacyRefreshIntradayToday();

  const result = await historyAggregator.refreshIntradayToday();
  expect(result.projectsUpdated).toBe(2);

  const actual = await readTodayRollupSimplified();
  expect(actual).toEqual(expected.map((b) => ({
    date: b.date,
    encodedCwd: b.encodedCwd,
    promptCount: b.promptCount,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    toolCallCount: b.toolCallCount,
    sessionCount: b.sessionCount,
  })));
});

test('a file modified today, in a directory the fast path would skip re-enumerating, is still picked up', async () => {
  // Session file whose FIRST event is today (this is what makes its
  // sessionDate bucket "today" at all — sessionDate is derived from the
  // file's first line, not its mtime). The first tick discovers it via a
  // real readdir (new directory) and caches the directory's mtime + file
  // list alongside it.
  const file = writeTranscript('/repo/resumed', 'sess-old', [
    userLine(todayAt(8).toISOString()),
    assistantLine(todayAt(8).toISOString(), 'claude-sonnet-5', { in: 10, out: 2 }),
  ], todayAt(8));

  const first = await historyAggregator.refreshIntradayToday();
  expect(first.projectsUpdated).toBe(1);

  // Now append to that SAME file later today, without creating or removing
  // any directory entry — appending to an existing file does NOT change the
  // parent directory's mtime (verified empirically; see the strategy comment
  // above refreshIntradayToday). A naive "skip the whole directory when its
  // mtime is unchanged" fast path would miss this update entirely; the real
  // implementation must keep re-stat-ing every previously-seen file in the
  // directory regardless.
  const dirPath = path.dirname(file);
  const dirStatBefore = fs.statSync(dirPath);

  fs.appendFileSync(file, JSON.stringify(assistantLine(todayAt(11).toISOString(), 'claude-sonnet-5', { in: 30, out: 6 })) + '\n');
  const todayStamp = todayAt(11);
  fs.utimesSync(file, todayStamp, todayStamp);

  const dirStatAfter = fs.statSync(dirPath);
  // Sanity check on the very premise this test is exercising: the directory
  // mtime genuinely did not move, so the second tick's fast path is forced to
  // reuse (not re-readdir) this directory's cached file list.
  expect(dirStatAfter.mtimeMs).toBe(dirStatBefore.mtimeMs);

  const second = await historyAggregator.refreshIntradayToday();
  expect(second.projectsUpdated).toBe(1);

  const rows = await readTodayRollupSimplified();
  expect(rows).toEqual([
    { date: today(), encodedCwd: encodeCwd('/repo/resumed'), promptCount: 1, inputTokens: 40, outputTokens: 8, toolCallCount: 0, sessionCount: 1 },
  ]);
});

test('a brand-new session file created after the first tick is discovered on the next tick', async () => {
  writeTranscript('/repo/steady', 'sess-a', [
    userLine(todayAt(8).toISOString()),
  ], todayAt(8));

  const first = await historyAggregator.refreshIntradayToday();
  expect(first.projectsUpdated).toBe(1);

  // New file in the SAME directory — this DOES bump the directory's mtime
  // (an entry was added), so the registry's cached file list must be
  // refreshed via readdir on the next tick.
  writeTranscript('/repo/steady', 'sess-b', [
    userLine(todayAt(9).toISOString()),
  ], todayAt(9));

  const second = await historyAggregator.refreshIntradayToday();
  expect(second.projectsUpdated).toBe(1);

  const rows = await readTodayRollupSimplified();
  expect(rows[0].sessionCount).toBe(2);
  expect(rows[0].promptCount).toBe(2);
});

test('mapWithConcurrency preserves input order and respects the concurrency bound', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  const results = await historyAggregator.mapWithConcurrency(items, 5, async (i) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return i * 2;
  });
  expect(results).toEqual(items.map((i) => i * 2));
  expect(maxInFlight).toBeLessThanOrEqual(5);
  expect(maxInFlight).toBeGreaterThan(1);
});
