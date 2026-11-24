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
  return { agentType, peakMb: Math.round(peakMb), at };
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
  function recordPeak({ agentType, peakMb, at } = {}) {
    const s = normalizeSample({ agentType, peakMb, at: at === undefined ? now() : at });
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

  function collectLogFiles(dir, depth, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0) collectLogFiles(p, depth - 1, out);
      } else if (e.isFile() && e.name.endsWith('.log')) {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(p).mtimeMs; } catch { continue; }
        out.push({ p, mtimeMs });
      }
    }
  }

  /**
   * Seeds an EMPTY store from run logs' 'memory scope <unit>: peak=<N>MB' lines
   * (agentType 'unknown', at = log mtime). Scans `dirs` (each a scheduler runs/
   * dir: <runId>/<slug>.log) and reads only the newest maxFiles logs. Never throws.
   * Returns the number of samples added (0 when the store already had samples).
   */
  function backfillFromRunLogs(dirs, { maxFiles = DEFAULT_MAX_FILES } = {}) {
    try {
      const file = resolveStorePath();
      if (readSamplesUncached(file).length > 0) return 0;
      const logs = [];
      for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
        if (typeof d === 'string' && d) collectLogFiles(d, 2, logs);
      }
      logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const picked = logs.slice(0, Math.max(0, maxFiles)).reverse(); // oldest first, like the live store
      const samples = [];
      for (const { p, mtimeMs } of picked) {
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const m of String(text).matchAll(PEAK_LINE_RE)) {
          samples.push({ agentType: 'unknown', peakMb: Number(m[2]), at: Math.round(mtimeMs) });
        }
      }
      if (!samples.length) return 0;
      appendSamples(samples);
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
  backfillFromRunLogs: defaultInstance.backfillFromRunLogs,
  createJobMemoryStats,
  quantile,
  STORE_FILE,
  MAX_SAMPLES,
  RECENT_PER_TYPE,
  MIN_SAMPLES,
  CACHE_MS,
};
