// @ts-check
'use strict';

/**
 * procGroupRss.cjs — summed resident memory (MB) of every process in a
 * process group, read from /proc (Linux only).
 *
 * Why: the scheduler's memory gate double-counted running jobs (2026-10-18).
 * Each job reserves 2500 MB, but part of that is already consumed and thus
 * already missing from MemAvailable; subtracting the full reservation again
 * counts it twice. Scheduler jobs are spawned `detached: true`, so a job's
 * pid leads its own process group and its tsc/vite/node children share that
 * pgid — summing the group's RSS tells the gate how much is already used.
 *
 * Parsing: /proc/<pid>/stat is `pid (comm) state ppid pgrp ... rss ...` and
 * comm may contain spaces and parentheses, so split only after the LAST ')'.
 * In the remainder (0-based): state=0, ppid=1, pgrp=2, rss=21 (pages).
 */

const fs = require('node:fs');

const PGRP_IDX = 2;
const RSS_IDX = 21;

/**
 * @param {number} pgid
 * @param {{ procRoot?: string, pageSizeKb?: number }} [opts]
 * @returns {number} integer MB (floor); 0 on any non-applicable/failed case
 */
function processGroupRssMb(pgid, opts = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return 0;
  if (process.platform !== 'linux') return 0;
  const procRoot = opts.procRoot ?? '/proc';
  const pageSizeKb = opts.pageSizeKb ?? 4;

  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return 0;
  }

  let totalKb = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`${procRoot}/${name}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      if (Number(fields[PGRP_IDX]) !== pgid) continue;
      const rssPages = Number(fields[RSS_IDX]);
      if (Number.isFinite(rssPages) && rssPages > 0) totalKb += rssPages * pageSizeKb;
    } catch {
      // vanished or unreadable entry — skip it
    }
  }
  return Math.floor(totalKb / 1024);
}

module.exports = { processGroupRssMb };
