'use strict';

/**
 * Derived-at-read-time counters answering "did this Epic delegate work into
 * PRDs, or did the interactive session just edit application source
 * inline?" — no new writer, no new namespace; both numbers are computed
 * from state that already exists on disk (single-writer law,
 * opsOwnership.cjs).
 *
 * prdsQueued reads the Epic's own live PRD dir
 * (session-manager-operations/scheduler/epics/<epicId>/prds/) — the
 * "prds-archived" sibling deliberately does NOT count here: this is a
 * live-delegation signal, not a lifetime PRD count (that's epicPrds() in
 * the renderer, sourced from the scheduler's own snapshot).
 *
 * inlineEdits reads the Epic's OWN interactive claude session transcript —
 * ~/.claude/projects/<encodeCwd(cwd)>/<claudeSessionId>.jsonl, the same file
 * transcripts.cjs already tails for the live feed — and counts Write/Edit/
 * NotebookEdit tool_use blocks whose file_path resolves under this repo's
 * src/, scripts/, plugins/, or bin/. That transcript already carries real
 * tool_use blocks (classifyTranscriptLine.cjs); the durable
 * session-manager-operations/prompt-sessions/transcripts/<epicId>.jsonl
 * store does NOT (it holds only rendered {role, text} turns, verified by
 * reading one), so it is not a usable source for this counter.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('./encodeCwd.cjs');
const { classifyLine } = require('./classifyTranscriptLine.cjs');

// Same cap transcripts.cjs's readDelta uses for a single pass — bounds
// memory/time on a very large transcript instead of reading it whole.
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

const INLINE_EDIT_TOOL_NAMES = new Set(['Write', 'Edit', 'NotebookEdit']);
const APPLICATION_SOURCE_PREFIXES = ['src/', 'scripts/', 'plugins/', 'bin/'];

function countPrdsQueued(cwd, epicId, deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  try {
    const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
    return readdirSync(dir).filter((name) => name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** True when `filePath` (absolute or relative) resolves to a path under
 *  cwd's src/, scripts/, plugins/, or bin/ — never a dotfile/root config,
 *  never a path outside the repo entirely. */
function isApplicationSourcePath(cwd, filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  const rel = path.relative(cwd, path.resolve(cwd, filePath)).split(path.sep).join('/');
  if (rel.startsWith('..')) return false;
  return APPLICATION_SOURCE_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
}

/** Reads at most the trailing MAX_TRANSCRIPT_BYTES of `filePath`, dropping
 *  a truncated leading partial line when the read didn't start at byte 0. */
function readTranscriptTail(filePath, deps = {}) {
  const statSync = deps.statSync || fs.statSync;
  const openSync = deps.openSync || fs.openSync;
  const readSync = deps.readSync || fs.readSync;
  const closeSync = deps.closeSync || fs.closeSync;

  const size = statSync(filePath).size;
  const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
}

function countInlineEdits(cwd, claudeSessionId, deps = {}) {
  if (!claudeSessionId) return 0;
  const readFn = deps.readTranscriptTail || readTranscriptTail;
  const homeDir = deps.homeDir || os.homedir();
  try {
    const filePath = path.join(homeDir, '.claude', 'projects', encodeCwd(cwd), `${claudeSessionId}.jsonl`);
    const text = readFn(filePath, deps);
    let count = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      for (const event of classifyLine(obj)) {
        if (event.kind !== 'tool_use') continue;
        const { name, input } = event.data || {};
        if (!INLINE_EDIT_TOOL_NAMES.has(name)) continue;
        if (isApplicationSourcePath(cwd, input?.file_path)) count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function computeEpicDelegationStats(cwd, epicId, claudeSessionId, deps = {}) {
  return {
    prdsQueued: countPrdsQueued(cwd, epicId, deps),
    inlineEdits: countInlineEdits(cwd, claudeSessionId, deps),
  };
}

module.exports = {
  computeEpicDelegationStats,
  countPrdsQueued,
  countInlineEdits,
  isApplicationSourcePath,
};
