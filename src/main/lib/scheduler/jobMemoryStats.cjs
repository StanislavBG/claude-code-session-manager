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
 * builds one with injected { fs, now, storePath, writeTextAtomicSync, writeTextAtomic } for tests
 * (writeTextAtomicSync: recordPeak's write; writeTextAtomic: the backfill's async write).
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

/**
 * Re-append identity of a stored sample, independent of its key order (never JSON.stringify).
 * With runId + unit: (runId, unit, at). Without either: every field (agentType, peakMb, at,
 * runId, unit), so a legacy or provenance-less peak never collides with another on `at` alone.
 */
function sampleKey(x) {
  if (x.runId && x.unit) return `p\0${x.runId}\0${x.unit}\0${x.at}`;
  return `f\0${x.agentType}\0${x.peakMb}\0${x.at}\0${x.runId || ''}\0${x.unit || ''}`;
}

function defaultStorePath() {
  return path.join(require('./schedulerPaths.cjs').schedulerHome(), STORE_FILE);
}

function createJobMemoryStats(deps = {}) {
  const fs = deps.fs || nodeFs;
  const now = deps.now || Date.now;
  const writeText = deps.writeTextAtomicSync || atomicFs.writeTextAtomicSync;
  const writeTextAsync = deps.writeTextAtomic || atomicFs.writeTextAtomic;
  const resolveStorePath = () => (typeof deps.storePath === 'function' ? deps.storePath() : deps.storePath) || defaultStorePath();
  let cache = null; // { at, file, samples }
  let liveDuringWrite = null; // live recordPeak samples landing while the backfill's async write is in flight

  function parseSamples(text) {
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

  function readSamplesUncached(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    return parseSamples(text);
  }

  async function readSamplesAsync(file) {
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { return []; }
    return parseSamples(text);
  }

  const serialize = (kept) => kept.map((x) => JSON.stringify(x)).join('\n') + (kept.length ? '\n' : '');

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
    writeText(file, serialize(kept));
    cache = { at: now(), file, samples: kept };
    return kept;
  }

  async function writeSamplesAsync(file, samples) {
    const kept = samples.slice(-MAX_SAMPLES);
    await writeTextAsync(file, serialize(kept));
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
    if (liveDuringWrite) liveDuringWrite.push(s);
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
   * `runsDir` is the scheduler runs folder (<runId>/<slug>.log). Only the newest
   * maxFiles × 2 run folders (by name — names are timestamps) are listed, whether
   * or not they hold logs, so a sparse runs folder never costs a listing per run;
   * among them the walk stops once maxFiles logs are picked, and only picked logs
   * are read and stat'd. A peak is deduped by run folder + scope unit (a stored
   * sample without a runId — a peak recorded before live peaks carried one — can
   * only match by unit).
   *
   * I/O: the store reads, run-log listings/reads/stats and the final store write
   * (util/atomicFs writeTextAtomic) are all fs.promises, run-log reads in batches
   * of at most BACKFILL_BATCH with an event-loop yield between batches. Nothing
   * runs synchronously except one case: when a live recordPeak lands while that
   * async write is in flight (our rename may have replaced its line), the store
   * is re-read and the missing live peak re-appended with the same synchronous
   * writer recordPeak itself uses. Never rejects. Resolves to the number added.
   */
  async function backfillFromRunLogs(runsDir, { maxFiles = DEFAULT_MAX_FILES } = {}) {
    try {
      if (typeof runsDir !== 'string' || !runsDir) return 0;
      const file = resolveStorePath();
      const existing = await readSamplesAsync(file);
      if (existing.length >= MIN_SAMPLES) return 0;
      const budget = Math.max(0, Math.floor(Number(maxFiles) || 0));
      if (!budget) return 0;
      const keyOf = (runId, unit) => `${runId}\0${unit}`;
      const seen = new Set();
      const legacyUnits = new Set(); // stored peaks with no run folder
      const noteStored = (samples) => {
        for (const x of samples) {
          if (!x.unit) continue;
          if (x.runId) seen.add(keyOf(x.runId, x.unit));
          else legacyUnits.add(x.unit);
        }
      };
      noteStored(existing);
      const isStored = (runId, unit) => seen.has(keyOf(runId, unit)) || legacyUnits.has(unit);
      const runIds = (await listDir(runsDir)).filter((e) => e.isDirectory()).map((e) => e.name)
        .sort().reverse().slice(0, budget * 2);
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
            if (isStored(r.runId, unit)) continue;
            seen.add(keyOf(r.runId, unit));
            found.push({ agentType: 'unknown', peakMb: Number(m[2]), at: Math.round(r.mtimeMs), runId: r.runId, unit });
          }
        }
      }
      // Re-read the store: a live recordPeak may have landed while the logs were read.
      liveDuringWrite = [];
      let samples;
      try {
        const current = await readSamplesAsync(file);
        seen.clear();
        noteStored(current);
        samples = [...perRun.values()].reverse().flat() // oldest first, like the live store
          .filter((x) => !isStored(x.runId, x.unit));
        if (!samples.length) return 0;
        await writeSamplesAsync(file, [...current, ...samples]);
      } finally {
        const landed = liveDuringWrite;
        liveDuringWrite = null;
        if (landed.length && samples && samples.length) {
          const stored = readSamplesUncached(file);
          const have = new Set(stored.map(sampleKey));
          const missing = landed.filter((x) => !have.has(sampleKey(x)));
          if (missing.length) writeSamples(file, [...stored, ...missing]);
        }
      }
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
  sampleKey,
  STORE_FILE,
  MAX_SAMPLES,
  RECENT_PER_TYPE,
  MIN_SAMPLES,
  CACHE_MS,
  DEFAULT_RESERVATION_MB,
  BACKFILL_BATCH,
};
