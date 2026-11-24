'use strict';

/**
 * jobMemoryStats.cjs — recorded per-job memory peaks → per-agentType reservation
 * and one shared spike buffer, so the memory gate can reserve what jobs really use
 * instead of a flat 2,500 MB (≈p93 of 2,457 measured scopes: p50 670, p75 1,269,
 * p90 1,994, p95 2,663, max 9,142 MB).
 *
 * Store: `<schedulerHome>/job-memory-peaks.jsonl`, one `{agentType, peakMb, at}`
 * per line, trimmed to the newest MAX_SAMPLES, rewritten via util/atomicFs.cjs.
 * Reads are cached CACHE_MS. Quantiles are nearest-rank. Pure Node, no Electron.
 *
 * The default instance's functions are the module exports; createJobMemoryStats()
 * builds one with injected { fs, now, storePath, writeTextAtomicSync } for tests.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const atomicFs = require('../util/atomicFs.cjs');

const STORE_FILE = 'job-memory-peaks.jsonl';
const MAX_SAMPLES = 2000;
const RECENT_PER_TYPE = 200;
const MIN_SAMPLES = 30;
const CACHE_MS = 60_000;
const DEFAULT_RESERVATION_MB = 2500;
const DEFAULT_TYPICAL_MB = 1000;
const DEFAULT_SPIKE_BUFFER_MB = 1500;
const RESERVATION_CLAMP = [800, 4000];
const TYPICAL_CLAMP = [300, 2500];
const SPIKE_CLAMP = [500, 3000];
const DEFAULT_MAX_FILES = 2000;
const BACKFILL_BATCH = 50; // run-log files read concurrently per batch
const PEAK_LINE_RE = /\[scheduler\] memory scope (\S+): peak=(\d+)MB/g;

function clamp(v, [lo, hi]) { return Math.min(hi, Math.max(lo, v)); }

/** Nearest-rank quantile: the ceil(q*n)-th smallest value (1-based). `values` need not be sorted. */
function quantile(values, q) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

function normalizeSample(s) {
  if (!s || typeof s !== 'object') return null;
  const peakMb = Number(s.peakMb);
  if (!Number.isFinite(peakMb) || peakMb < 0) return null;
  const agentType = typeof s.agentType === 'string' && s.agentType ? s.agentType : 'unknown';
  const at = Number.isFinite(Number(s.at)) ? Number(s.at) : 0;
  const out = { agentType, peakMb: Math.round(peakMb), at };
  // Optional provenance: the run folder + scope unit, so the boot backfill never re-adds a peak.
  if (typeof s.runId === 'string' && s.runId) out.runId = s.runId;
  if (typeof s.unit === 'string' && s.unit) out.unit = s.unit;
  return out;
}

function defaultStorePath() {
  return path.join(require('./schedulerPaths.cjs').schedulerHome(), STORE_FILE);
}

function createJobMemoryStats(deps = {}) {
  const fs = deps.fs || nodeFs;
  const now = deps.now || Date.now;
  const writeText = deps.writeTextAtomicSync || atomicFs.writeTextAtomicSync;
  const resolveStorePath = () => (typeof deps.storePath === 'function' ? deps.storePath() : deps.storePath) || defaultStorePath();
  let cache = null; // { at, file, samples }

  function readSamplesUncached(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      try {
        const s = normalizeSample(JSON.parse(line));
        if (s) out.push(s);
      } catch { /* skip a torn line */ }
    }
    return out;
  }

  /** All stored samples, oldest first (file order). Cached CACHE_MS per store path. */
  function loadSamples() {
    const file = resolveStorePath();
    const t = now();
    if (cache && cache.file === file && t - cache.at < CACHE_MS) return cache.samples;
    const samples = readSamplesUncached(file);
    cache = { at: t, file, samples };
    return samples;
  }

  function writeSamples(file, samples) {
    const kept = samples.slice(-MAX_SAMPLES);
    writeText(file, kept.map((s) => JSON.stringify(s)).join('\n') + (kept.length ? '\n' : ''));
    cache = { at: now(), file, samples: kept };
    return kept;
  }

  function appendSamples(newSamples) {
    const file = resolveStorePath();
    const existing = readSamplesUncached(file);
    return writeSamples(file, [...existing, ...newSamples]);
  }

  /** Records one job's peak. Returns the stored sample, or null when the input is unusable. */
  function recordPeak({ agentType, peakMb, at, runId, unit } = {}) {
    const s = normalizeSample({ agentType, peakMb, at: at === undefined ? now() : at, runId, unit });
    if (!s) return null;
    appendSamples([s]);
    return s;
  }

  /** Peaks to take quantiles of: agentType's newest 200 when it has ≥30, else all when ≥30, else null. */
  function basisFor(agentType) {
    const all = loadSamples();
    const own = all.filter((s) => s.agentType === agentType);
    if (own.length >= MIN_SAMPLES) return own.slice(-RECENT_PER_TYPE).map((s) => s.peakMb);
    if (all.length >= MIN_SAMPLES) return all.map((s) => s.peakMb);
    return null;
  }

  /** p75 peak for agentType (MB), clamped 800-4000; 2500 with too few samples. */
  function reservationMb(agentType) {
    const basis = basisFor(agentType);
    if (!basis) return DEFAULT_RESERVATION_MB;
    return clamp(quantile(basis, 0.75), RESERVATION_CLAMP);
  }

  /** p50 peak for agentType (MB), clamped 300-2500; 1000 with too few samples. */
  function typicalPeakMb(agentType) {
    const basis = basisFor(agentType);
    if (!basis) return DEFAULT_TYPICAL_MB;
    return clamp(quantile(basis, 0.5), TYPICAL_CLAMP);
  }

  /** p95 − p75 of all samples (one job at its p95 while the rest sit near p75), clamped 500-3000; 1500 with too few. */
  function spikeBufferMb() {
    const all = loadSamples().map((s) => s.peakMb);
    if (all.length < MIN_SAMPLES) return DEFAULT_SPIKE_BUFFER_MB;
    return clamp(quantile(all, 0.95) - quantile(all, 0.75), SPIKE_CLAMP);
  }

  /** True once the store holds ≥ MIN_SAMPLES peaks, i.e. the quantiles above are measured, not fallbacks. */
  function isMeasured() {
    return loadSamples().length >= MIN_SAMPLES;
  }

  /** Directory entries under dir (async), or [] when unreadable. */
  async function listDir(dir) {
    try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  }

  /** Yields the event loop once (between read batches). */
  const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

  /**
   * Seeds the store from run logs' 'memory scope <unit>: peak=<N>MB' lines
   * (agentType 'unknown', at = log mtime) while it holds fewer than MIN_SAMPLES.
   * `runsDir` is the scheduler runs folder (<runId>/<slug>.log); run folders are
   * walked by name, newest first (names are timestamps), and the walk stops once
   * maxFiles logs are picked — only picked logs are read and stat'd. All run-log
   * I/O is fs.promises, in batches of at most BACKFILL_BATCH files with an event
   * loop yield between batches, so it never blocks the Electron main thread.
   * A sample whose run folder + unit (or, for a live-recorded peak, unit) is
   * already stored is skipped. Never rejects. Resolves to the number added.
   */
  async function backfillFromRunLogs(runsDir, { maxFiles = DEFAULT_MAX_FILES } = {}) {
    try {
      if (typeof runsDir !== 'string' || !runsDir) return 0;
      const file = resolveStorePath();
      const existing = readSamplesUncached(file);
      if (existing.length >= MIN_SAMPLES) return 0;
      const seen = new Set();
      for (const s of existing) {
        if (!s.unit) continue;
        seen.add(`unit\0${s.unit}`);
        if (s.runId) seen.add(`${s.runId}\0${s.unit}`);
      }
      const budget = Math.max(0, Math.floor(Number(maxFiles) || 0));
      if (!budget) return 0;
      const runIds = (await listDir(runsDir)).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
      // Pick the newest `budget` logs: [{ runId, p }], newest run first.
      const picked = [];
      for (const runId of runIds) {
        if (picked.length >= budget) break;
        const dir = path.join(runsDir, runId);
        const logs = (await listDir(dir)).filter((e) => e.isFile() && e.name.endsWith('.log')).map((e) => e.name).sort();
        for (const name of logs) {
          if (picked.length >= budget) break;
          picked.push({ runId, p: path.join(dir, name) });
        }
      }
      const readOne = async ({ runId, p }) => {
        let text;
        try { text = await fs.promises.readFile(p, 'utf8'); } catch { return null; }
        let mtimeMs = 0;
        try { mtimeMs = (await fs.promises.stat(p)).mtimeMs; } catch { /* keep 0 */ }
        return { runId, text: String(text), mtimeMs };
      };
      const perRun = new Map(); // runId → samples, insertion order = newest run first
      for (let i = 0; i < picked.length; i += BACKFILL_BATCH) {
        if (i > 0) await yieldTurn();
        const results = await Promise.all(picked.slice(i, i + BACKFILL_BATCH).map(readOne));
        for (const r of results) {
          if (!r) continue;
          if (!perRun.has(r.runId)) perRun.set(r.runId, []);
          const found = perRun.get(r.runId);
          for (const m of r.text.matchAll(PEAK_LINE_RE)) {
            const unit = m[1];
            if (seen.has(`${r.runId}\0${unit}`) || seen.has(`unit\0${unit}`)) continue;
            seen.add(`${r.runId}\0${unit}`);
            found.push({ agentType: 'unknown', peakMb: Number(m[2]), at: Math.round(r.mtimeMs), runId: r.runId, unit });
          }
        }
      }
      // Re-read the store: a live recordPeak may have landed while the logs were read.
      const current = readSamplesUncached(file);
      const liveUnits = new Set(current.map((s) => s.unit).filter(Boolean));
      const samples = [...perRun.values()].reverse().flat() // oldest first, like the live store
        .filter((s) => !liveUnits.has(s.unit));
      if (!samples.length) return 0;
      writeSamples(file, [...current, ...samples]);
      return Math.min(samples.length, MAX_SAMPLES);
    } catch {
      return 0;
    }
  }

  return {
    recordPeak,
    reservationMb,
    typicalPeakMb,
    spikeBufferMb,
    isMeasured,
    backfillFromRunLogs,
    loadSamples,
    _resetCache() { cache = null; },
  };
}

const defaultInstance = createJobMemoryStats();

module.exports = {
  recordPeak: defaultInstance.recordPeak,
  reservationMb: defaultInstance.reservationMb,
  typicalPeakMb: defaultInstance.typicalPeakMb,
  spikeBufferMb: defaultInstance.spikeBufferMb,
  isMeasured: defaultInstance.isMeasured,
  backfillFromRunLogs: defaultInstance.backfillFromRunLogs,
  createJobMemoryStats,
  quantile,
  STORE_FILE,
  MAX_SAMPLES,
  RECENT_PER_TYPE,
  MIN_SAMPLES,
  CACHE_MS,
  DEFAULT_RESERVATION_MB,
  BACKFILL_BATCH,
};
