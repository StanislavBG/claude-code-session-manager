/**
 * loopEfficiencyHandlers.cjs — `history:loop-efficiency` IPC. Gathers this
 * usage week's run records + validator verdicts from the runs dir and feeds
 * the pure calculator in lib/scheduler/loopEfficiency.cjs.
 *
 * Complexity O(runs in window); run logs are immutable after finalize, so
 * validator verdicts are memoized per log path.
 */

'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { ipcMain } = require('electron');
const { computeLoopEfficiency } = require('./lib/scheduler/loopEfficiency.cjs');
const { parseValidationSentinels } = require('./lib/scheduler/validationSentinels.cjs');

const WEEK_MS = 7 * 24 * 3600 * 1000;
const LOG_TAIL_BYTES = 1024 * 1024;
const USAGE_TIMEOUT_MS = 5000;
const VALIDATOR_SLUG_RE = /(^|-)validate-/;

/** @type {Map<string, Array<{ slug: string, verdict: string, reason: string }>>} */
const validationMemo = new Map();

/** `2026-10-23T01-26-37-026Z` -> epoch ms (NaN if not a run dir name). */
function runIdToMs(runId) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(runId);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

async function readJson(p) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; }
}

/** Last 1 MB of a file as text ('' on failure). */
async function readTail(p) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function validationsForLog(logPath) {
  const hit = validationMemo.get(logPath);
  if (hit) return hit;
  let out = [];
  const tail = await readTail(logPath);
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"result"')) continue;
    try {
      const obj = JSON.parse(lines[i]);
      if (typeof obj.result === 'string') out = parseValidationSentinels(obj.result);
    } catch { /* torn line — treat as no verdicts */ }
    break;
  }
  validationMemo.set(logPath, out);
  return out;
}

/** Never throws; resolves null on any failure or after 5 s. */
async function defaultUsage(fetchUsage) {
  let timer;
  try {
    const fetchFn = fetchUsage || require('./usage.cjs').fetchUsage;
    const r = await Promise.race([
      fetchFn(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), USAGE_TIMEOUT_MS); }),
    ]);
    if (!r) return null;
    // 'ok-stale' = last cached payload served while the API fails / rate-limits.
    if (r.kind === 'ok' || r.kind === 'ok-stale') return r.data && r.data.usage ? r.data.usage : null;
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {{ runsRoot?: string, nowMs?: number, usage?: any }} [opts]
 *   `usage` is the usage payload (`{ seven_day: { utilization, resets_at } }`) or null.
 */
async function gatherLoopEfficiency({ runsRoot, nowMs, usage } = {}) {
  const root = runsRoot || require('./lib/scheduler/schedulerPaths.cjs').runsDir();
  const now = typeof nowMs === 'number' ? nowMs : Date.now();

  let fromMs = now - WEEK_MS;
  let weeklyUtilizationPct = null;
  const sd = usage && usage.seven_day;
  if (sd && sd.resets_at && typeof sd.utilization === 'number') {
    const reset = typeof sd.resets_at === 'number' ? sd.resets_at : Date.parse(sd.resets_at);
    if (Number.isFinite(reset)) {
      fromMs = reset - WEEK_MS;
      weeklyUtilizationPct = sd.utilization;
    }
  }

  const runs = [];
  const validations = [];
  let dirs = [];
  try { dirs = await fsp.readdir(root); } catch { /* no runs dir */ }

  for (const runId of dirs) {
    const t = runIdToMs(runId);
    if (!Number.isFinite(t) || t < fromMs) continue;
    const runDir = path.join(root, runId);
    let files;
    try { files = await fsp.readdir(runDir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.meta.json')) continue;
      const meta = await readJson(path.join(runDir, f));
      if (!meta || typeof meta !== 'object') continue;
      // Slug comes from the filename, never meta content (no path traversal via meta.slug).
      const slug = f.slice(0, -'.meta.json'.length);
      const vd = await readJson(path.join(runDir, `${slug}.verdicts.json`));
      const startedAtMs = typeof meta.startedAt === 'number' ? meta.startedAt : t;
      const cwd = String(meta.cwd == null ? '' : meta.cwd);
      runs.push({
        cwd,
        slug,
        startedAtMs,
        costUsd: meta.totalCostUsd,
        verdict: vd && typeof vd.verdict === 'string' ? vd.verdict : null,
      });
      if (VALIDATOR_SLUG_RE.test(slug)) {
        for (const v of await validationsForLog(path.join(runDir, `${slug}.log`))) {
          validations.push({
            cwd,
            slug: v.slug,
            verdict: v.verdict === 'verified' ? 'VERIFIED' : 'REFUTED',
            atMs: startedAtMs,
          });
        }
      }
    }
  }

  return computeLoopEfficiency({ runs, validations, fromMs, toMs: now, weeklyUtilizationPct });
}

function registerLoopEfficiencyHandlers() {
  ipcMain.handle('history:loop-efficiency', async () => {
    const usage = await defaultUsage();
    return gatherLoopEfficiency({ nowMs: Date.now(), usage });
  });
}

module.exports = { gatherLoopEfficiency, registerLoopEfficiencyHandlers, defaultUsage };
