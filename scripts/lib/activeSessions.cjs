'use strict';

// activeSessions.cjs — returns distinct on-disk project cwds with an active
// session within maxAgeMin minutes. Used by the feedback sweep (PRD 102) to
// narrow scanning to projects the user is actually working in.
//
// Detection is transcript-based only (scans ~/.claude/projects/*/*.jsonl
// mtimes). It has zero dependency on ~/.claude/knowledge-log/prompts.jsonl,
// which PRD 356-retire purges along with its capture hook.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

// Transcript reads only need the last line with a `cwd` field — a few dozen
// lines is always enough. 64 KB keeps peak RSS proportionate.
const TAIL_BYTES = 64 * 1024;

// Safety cap on distinct cwds to bound result set size. O(1) extra space.
const MAX_CWDS = 50;

/**
 * readTailLines(filePath, maxBytes) → string[]
 * Reads at most maxBytes from the END of filePath and splits into non-empty lines.
 * O(1) in file size (bounded read). Returns [] on any I/O error.
 */
function readTailLines(filePath, maxBytes) {
  let buf;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];
    const readSize = Math.min(maxBytes, stat.size);
    const fd = fs.openSync(filePath, 'r');
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  return buf.toString('utf8').split('\n').filter((l) => l.trim());
}

/**
 * activeProjectCwds(maxAgeMin = 90, opts?) → string[]
 *
 * Returns distinct, on-disk project cwds that have an open/active session
 * within the last maxAgeMin minutes.
 *
 * Sole detection path: scan ~/.claude/projects/*​/  for transcript *.jsonl
 *   files modified within maxAgeMin, read `cwd` from the last parseable line
 *   of the newest transcript per project dir.
 *   Complexity: O(P × L) over P project dirs, each bounded-tail read (64 KB).
 *
 * opts (for testing):
 *   projectsDir  — override the default ~/.claude/projects path
 */
function activeProjectCwds(maxAgeMin = 90, {
  projectsDir = path.join(HOME, '.claude', 'projects'),
} = {}) {
  const cutoffMs = Date.now() - maxAgeMin * 60 * 1000;
  const seen = new Set();
  const result = [];

  function addCwd(cwd) {
    if (!cwd || typeof cwd !== 'string') return;
    if (seen.has(cwd) || result.length >= MAX_CWDS) return;
    try { fs.statSync(cwd); } catch { return; } // must exist on disk
    seen.add(cwd);
    result.push(cwd);
  }

  // Scan ~/.claude/projects/*/  transcript *.jsonl files.
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch { return result; }

  for (const slug of slugs) {
    if (result.length >= MAX_CWDS) break;
    const projDir = path.join(projectsDir, slug);
    let entries;
    try {
      entries = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }

    // Find the most recently modified transcript in this project dir.
    let newestPath = null;
    let newestMtimeMs = 0;
    for (const tf of entries) {
      const fp = path.join(projDir, tf);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs > newestMtimeMs) {
          newestMtimeMs = st.mtimeMs;
          newestPath = fp;
        }
      } catch { continue; }
    }

    if (!newestPath || newestMtimeMs < cutoffMs) continue;

    // Read `cwd` from the last parseable line of the transcript.
    const tlines = readTailLines(newestPath, TAIL_BYTES);
    for (let i = tlines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(tlines[i]); } catch { continue; }
      if (row.cwd) { addCwd(row.cwd); break; }
    }
  }

  return result;
}

module.exports = { activeProjectCwds };
