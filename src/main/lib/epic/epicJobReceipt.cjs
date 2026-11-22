/**
 * epicJobReceipt.cjs — sums the scheduler run metadata (`<runId>/<slug>.meta.json`)
 * of one Epic's PRDs, every attempt included, into a cost/usage receipt.
 *
 * Complexity: one listing per run dir since sinceMs; only wanted meta files that exist are
 * opened. Never rejects: a missing runs dir, unreadable run dir or malformed meta file is skipped.
 */

'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { runIdToMs } = require('../../loopEfficiencyHandlers.cjs');

const META_SUFFIX = '.meta.json';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function readJson(p) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; }
}

/**
 * @param {{ cwd: string, slugs: string[], sinceMs?: number, runsRoot?: string }} opts
 * @returns {Promise<{ runs: number, costUsd: number, costKnownRuns: number, outputTokens: number,
 *   numTurns: number, durationMs: number,
 *   byPrd: Array<{ slug: string, runs: number, costUsd: number, lastExitCode: number|null, lastFinishedAt: number|null }> }>}
 */
async function gatherEpicJobReceipt({ cwd, slugs, sinceMs, runsRoot } = /** @type {any} */ ({})) {
  const out = { runs: 0, costUsd: 0, costKnownRuns: 0, outputTokens: 0, numTurns: 0, durationMs: 0, byPrd: [] };
  try {
    const root = runsRoot || require('../scheduler/schedulerPaths.cjs').runsDir();
    const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : -Infinity;
    // Slugs name files inside a run dir — reject anything that could escape it.
    const wanted = new Set((Array.isArray(slugs) ? slugs : [])
      .filter((s) => typeof s === 'string' && s && !s.includes('/') && !s.includes('\\') && s !== '.' && s !== '..'));
    /** @type {Map<string, { slug: string, runs: number, costUsd: number, lastExitCode: number|null, lastFinishedAt: number|null, lastAt: number }>} */
    const per = new Map();

    let dirs = [];
    try { dirs = await fsp.readdir(root); } catch { /* no runs dir */ }

    for (const runId of dirs) {
      const t = runIdToMs(runId);
      if (!Number.isFinite(t) || t < since) continue;
      const runDir = path.join(root, runId);
      let files;
      try { files = await fsp.readdir(runDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(META_SUFFIX)) continue;
        // Slug comes from the filename and must be in the guarded wanted set.
        const slug = f.slice(0, -META_SUFFIX.length);
        if (!wanted.has(slug)) continue;
        const meta = await readJson(path.join(runDir, f));
        if (!meta || typeof meta !== 'object' || meta.cwd !== cwd) continue;
        let row = per.get(slug);
        if (!row) {
          row = { slug, runs: 0, costUsd: 0, lastExitCode: null, lastFinishedAt: null, lastAt: -Infinity };
          per.set(slug, row);
        }
        out.runs += 1;
        row.runs += 1;
        if (typeof meta.totalCostUsd === 'number' && Number.isFinite(meta.totalCostUsd)) {
          out.costUsd += meta.totalCostUsd;
          out.costKnownRuns += 1;
          row.costUsd += meta.totalCostUsd;
        }
        out.outputTokens += num(meta.outputTokens);
        out.numTurns += num(meta.numTurns);
        out.durationMs += num(meta.durationMs);
        const finishedAt = typeof meta.finishedAt === 'number' ? meta.finishedAt : null;
        const at = finishedAt != null ? finishedAt : t;
        if (at >= row.lastAt) {
          row.lastAt = at;
          row.lastExitCode = typeof meta.exitCode === 'number' ? meta.exitCode : null;
          row.lastFinishedAt = finishedAt;
        }
      }
    }

    out.byPrd = [...per.values()]
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map(({ slug, runs, costUsd, lastExitCode, lastFinishedAt }) => ({ slug, runs, costUsd, lastExitCode, lastFinishedAt }));
  } catch { /* never reject — return what was gathered */ }
  return out;
}

module.exports = { gatherEpicJobReceipt };
