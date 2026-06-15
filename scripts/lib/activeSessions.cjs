'use strict';

// activeSessions.cjs — returns distinct on-disk project cwds with an active
// session within maxAgeMin minutes. Used by the feedback sweep (PRD 102) to
// narrow scanning to projects the user is actually working in.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

// Mirrors kg.cjs:MAX_TAIL_BYTES — bound reads so a >100 MB log doesn't OOM.
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

// Fallback transcript reads only need the last line with a `cwd` field —
// a few dozen lines is always enough. 64 KB keeps peak RSS proportionate.
const FALLBACK_TAIL_BYTES = 64 * 1024;

// Safety cap on distinct cwds to bound result set size. O(1) extra space.
const MAX_CWDS = 50;

/**
 * parseTs(ts) → number | null
 * Accepts ISO-8601 string or epoch-ms number. Returns ms since epoch, or null.
 */
function parseTs(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

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
 * Primary path: tail-scan ~/.claude/knowledge-log/prompts.jsonl.
 *   Each line: { ts, session_id, cwd, transcript_path, prompt }
 *   ts may be ISO-8601 string or epoch-ms number.
 *   Complexity: O(N) over tail lines, where N ≤ MAX_TAIL_BYTES / avg-line-length.
 *
 * Fallback (log missing or has no parseable lines): scan ~/.claude/projects/
 *   for transcript *.jsonl files modified within maxAgeMin, read `cwd` from
 *   the last parseable line of the newest transcript per project dir.
 *   Complexity: O(P × L) over P project dirs, each bounded-tail read (64 KB).
 *
 * opts (for testing):
 *   logPath      — override the default prompts.jsonl path
 *   projectsDir  — override the default ~/.claude/projects path
 */
function activeProjectCwds(maxAgeMin = 90, {
  logPath = path.join(HOME, '.claude', 'knowledge-log', 'prompts.jsonl'),
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

  // Primary: prompts.jsonl tail scan.
  const lines = readTailLines(logPath, MAX_TAIL_BYTES);
  let primaryHasData = false;

  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    // Any parseable JSON line proves the log has data — don't gate on ts presence.
    primaryHasData = true;
    const tsMs = parseTs(parsed.ts);
    if (tsMs === null) continue;
    if (tsMs >= cutoffMs) addCwd(parsed.cwd);
  }

  // Return primary results even if empty (e.g. all entries are stale).
  // Fallback only when the log has no parseable data at all.
  if (primaryHasData) return result;

  // Fallback: scan ~/.claude/projects/*/  transcript *.jsonl files.
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
    const tlines = readTailLines(newestPath, FALLBACK_TAIL_BYTES);
    for (let i = tlines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(tlines[i]); } catch { continue; }
      if (row.cwd) { addCwd(row.cwd); break; }
    }
  }

  return result;
}

module.exports = { activeProjectCwds };
