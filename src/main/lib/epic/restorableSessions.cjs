'use strict';

/**
 * restorableSessions.cjs — which Claude Code CLI sessions already on disk for
 * ONE project could a new Epic adopt? Powers the New Session card's "Restore a
 * session" option, so a first-time Session Manager user can carry on a
 * conversation they started in the plain CLI.
 *
 * A transcript `~/.claude/projects/<encodeCwd(cwd)>/<id>.jsonl` is restorable when:
 *   - `<id>` is a session UUID (SESSION_ID_RE). It becomes a filename and a
 *     `--resume` argument, so nothing else is ever joined into a path;
 *   - its first recorded `cwd` is exactly this project's. encodeCwd is lossy
 *     (`/a/b-c` and `/a/b/c` share a dir), so the transcript itself decides;
 *   - its head holds a real user prompt (not a sidechain, meta, slash-command
 *     or tool_result row);
 *   - no Epic owns it (EPIC : claude-session is 1:1): the id is not a
 *     `claudeSessionId` in active-index.json or in any archived
 *     prompt-sessions/<id>.json (claimedClaudeSessionIds).
 *
 * Bounded on purpose. One project dir on the author's machine holds 1,500+
 * transcripts (p50 800 KB, max 14 MB), and walking all of ~/.claude/projects is
 * a known main-process OOM hazard. So this module:
 *   - reads ONE project dir and never enumerates ~/.claude/projects itself;
 *   - reads at most the first and the last 64 KiB of a transcript through fixed
 *     buffers (never readFile) and parses only complete lines;
 *   - head-reads at most 200 transcripts per call, newest first, and reports
 *     `truncated` when candidates remained;
 *   - memoises the claimed-id scan per cwd on each ops file's mtimeMs:size, so
 *     an unchanged Epic file is never re-read (epicTranscriptPath.cjs's shape).
 *
 * Read-only: never writes, never spawns. listRestorableSessions is async (it
 * backs a picker IPC); checkRestorableSessionSync is the sync single-id gate
 * the mint path reuses. It re-derives every fact from disk instead of trusting
 * an earlier list.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeCwd } = require('../util/encodeCwd.cjs');
// Module object, not destructured: the memo test spies on readJsonOrSync.
const atomicFs = require('../util/atomicFs.cjs');
const { readActiveIndex } = require('./epicMint.cjs');

/** A Claude Code session id: hex UUID 8-4-4-4-12, either case. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_HEAD_READS = 200;
const DEFAULT_LIMIT = 50;
const MAX_TEXT = 300;
const RECENT_MS = 120 * 1000;
const STAT_CONCURRENCY = 16;
const NEWLINE = 0x0a;
const JSONL = '.jsonl';
// Once a head's early facts are known, a line holding none of these strings is never parsed.
const LATE_ROW_HINTS = ['"last-prompt"', '"custom-title"', '"summary"'];

/**
 * @typedef {object} RestorableDeps
 * @property {string} [homeDir] Home dir holding `.claude/projects` (default os.homedir()).
 * @property {() => number} [now] Clock for `recentlyActive` (default Date.now).
 * @property {(cwd: string) => { sessions?: Record<string, unknown> }} [readActiveIndex] Test seam (default epicMint's).
 */

/**
 * @typedef {object} RestorableSession
 * @property {string} sessionId
 * @property {string|null} title Last `custom-title` row, else last `summary` row.
 * @property {string} firstPrompt First real user prompt in the head.
 * @property {string|null} lastPrompt Last `last-prompt` row read (the tail; the whole file when it fits the head).
 * @property {string|null} gitBranch First `gitBranch` recorded.
 * @property {boolean} headless First recorded `entrypoint` is `sdk-*` (a `claude -p` / SDK run).
 * @property {number} mtimeMs
 * @property {number} sizeBytes
 * @property {boolean} recentlyActive Written in the last 120 s, so it may still be open in a terminal.
 */

/**
 * @typedef {object} RestorableList
 * @property {RestorableSession[]} sessions Newest first by mtime.
 * @property {number} hiddenClaimed Transcripts left out because an Epic owns them.
 * @property {number} scanned Transcript heads read by this call (at most 200).
 * @property {boolean} truncated The walk stopped (limit or the 200-read cap) with candidates left.
 */

/** @typedef {'invalid_id'|'not_found'|'cwd_mismatch'|'claimed'} RefusalCode */
/** @typedef {{ ok: true, transcriptPath: string }} RestorableOk */
/** @typedef {{ ok: false, code: RefusalCode, message: string }} RestorableRefusal */

/** @typedef {Record<string, unknown>} Row */

/**
 * What one transcript's head (and tail) windows say. Text fields are clipped;
 * '' means "no such row seen".
 * @typedef {object} TranscriptFacts
 * @property {string|null} recordedCwd First string `cwd` (raw).
 * @property {string|null} firstPrompt
 * @property {string|null} entrypoint First `entrypoint` (raw).
 * @property {string|null} gitBranch First `gitBranch`.
 * @property {string} lastPrompt
 * @property {string} customTitle
 * @property {string} summary
 */

/** @typedef {{ name: string, sessionId: string, mtimeMs: number, sizeBytes: number }} Candidate */

/** @typedef {{ key: string, sid: string|null }} ArchiveRec */

/** @type {Map<string, { indexKey: string, indexIds: string[], files: Map<string, ArchiveRec> }>} */
const claimedCache = new Map();

function __resetCacheForTests() {
  claimedCache.clear();
}

/**
 * @param {string} file
 * @returns {string} `mtimeMs:size`, or 'missing'
 */
function statKey(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * Absolute, normalized project cwd, or null. A relative cwd would resolve
 * against the main process's own cwd, which names no project.
 * @param {unknown} cwd
 * @returns {string|null}
 */
function normalizeCwd(cwd) {
  return typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd) : null;
}

/**
 * `~/.claude/projects/<encodeCwd(projectCwd)>`, the one dir this module reads.
 * @param {string} projectCwd
 * @param {RestorableDeps} deps
 */
function projectDirOf(projectCwd, deps) {
  return path.join(deps.homeDir || os.homedir(), '.claude', 'projects', encodeCwd(projectCwd));
}

/**
 * @param {unknown} session
 * @returns {string|null}
 */
function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return null;
  const sid = /** @type {Row} */ (session).claudeSessionId;
  return typeof sid === 'string' && sid ? sid : null;
}

/**
 * Every claudeSessionId an Epic of this project owns: active-index.json plus
 * each archived prompt-sessions/<id>.json. Memoised per cwd on each file's
 * mtimeMs:size, so an unchanged file is never re-read (one statSync per file per
 * call). A cwd with no ops root (relative, tmpdir or linked worktree) cannot
 * hold Epics, so it owns nothing.
 * @param {string} cwd Project cwd (mapped to its ops root by opsPath).
 * @param {RestorableDeps} [deps]
 * @returns {Set<string>}
 */
function claimedClaudeSessionIds(cwd, deps) {
  /** @type {Set<string>} */
  const ids = new Set();
  if (typeof cwd !== 'string' || !cwd) return ids;
  const d = deps || {};
  let dir;
  try {
    // Lazy, as in epicMint.cjs: opsOwnership → ephemeralCwd → activeSessions.
    const { opsPath } = require('../opsOwnership.cjs');
    dir = opsPath(cwd, 'prompt-sessions');
  } catch {
    return ids;
  }
  const prev = claimedCache.get(cwd);

  const indexKey = statKey(path.join(dir, 'active-index.json'));
  /** @type {string[]} */
  let indexIds = [];
  if (prev && prev.indexKey === indexKey) {
    indexIds = prev.indexIds;
  } else {
    /** @type {Record<string, unknown>} */
    let sessions = {};
    try {
      sessions = (d.readActiveIndex || readActiveIndex)(cwd).sessions || {};
    } catch {
      sessions = {};
    }
    for (const s of Object.values(sessions)) {
      const sid = sessionIdOf(s);
      if (sid) indexIds.push(sid);
    }
  }

  const prevFiles = prev ? prev.files : new Map();
  /** @type {Map<string, ArchiveRec>} */
  const files = new Map();
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'active-index.json') continue;
    const file = path.join(dir, name);
    const key = statKey(file);
    const hit = prevFiles.get(name);
    if (hit && hit.key === key) {
      files.set(name, hit);
      continue;
    }
    const doc = atomicFs.readJsonOrSync(file, null);
    files.set(name, { key, sid: doc && typeof doc === 'object' ? sessionIdOf(doc.session) : null });
  }
  claimedCache.set(cwd, { indexKey, indexIds, files });

  for (const sid of indexIds) ids.add(sid);
  for (const rec of files.values()) if (rec.sid) ids.add(rec.sid);
  return ids;
}

/**
 * Case-folded copy: a case-insensitive filesystem (macOS) maps `ABC….jsonl`
 * and `abc….jsonl` to one transcript, so ownership is compared folded.
 * @param {Set<string>} set
 * @returns {Set<string>}
 */
function lowerSet(set) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const s of set) out.add(s.toLowerCase());
  return out;
}

/**
 * Trimmed and capped at 300 chars without splitting a surrogate pair; '' for
 * a non-string.
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (t.length <= MAX_TEXT) return t;
  let cut = t.slice(0, MAX_TEXT);
  const last = cut.charCodeAt(MAX_TEXT - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/**
 * Complete lines of a window. The text after the last newline is always
 * dropped (a head cut mid-row, or a row still being written); `dropFirst`
 * also drops a tail window's leading partial line. Cutting at newline bytes
 * keeps the UTF-8 decode aligned, since 0x0a never occurs inside a multibyte
 * character.
 * @param {Buffer} buf
 * @param {boolean} dropFirst
 * @returns {string[]}
 */
function completeLines(buf, dropFirst) {
  const end = buf.lastIndexOf(NEWLINE);
  if (end < 0) return [];
  const start = dropFirst ? buf.indexOf(NEWLINE) + 1 : 0;
  if (start > end) return [];
  return buf.toString('utf8', start, end).split('\n');
}

/**
 * @param {string} line
 * @returns {Row|null}
 */
function parseRow(line) {
  if (!line) return null;
  try {
    const row = JSON.parse(line);
    return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  } catch {
    return null;
  }
}

/** @param {string} line */
function mayBeLateRow(line) {
  return LATE_ROW_HINTS.some((hint) => line.includes(hint));
}

/**
 * Fold a title / last-prompt row into `facts`; the last row of each kind wins.
 * @param {Row} row
 * @param {TranscriptFacts} facts
 */
function noteLateRow(row, facts) {
  if (row.type === 'last-prompt' && typeof row.lastPrompt === 'string') facts.lastPrompt = clip(row.lastPrompt);
  else if (row.type === 'custom-title' && typeof row.customTitle === 'string') facts.customTitle = clip(row.customTitle);
  else if (row.type === 'summary' && typeof row.summary === 'string') facts.summary = clip(row.summary);
}

/**
 * @param {string} text
 * @returns {string|null}
 */
function promptOrNull(text) {
  const t = text.trim();
  if (!t || t.startsWith('<command-') || t.startsWith('<local-command-')) return null;
  return clip(t);
}

/**
 * The row's prompt when it is a real user prompt: not a sidechain or meta row,
 * not a slash-command / local-command echo, not tool_result-only content.
 * @param {Row} row
 * @returns {string|null}
 */
function userPromptText(row) {
  if (row.type !== 'user' || row.isSidechain === true || row.isMeta === true) return null;
  const message = row.message;
  const content = message && typeof message === 'object' ? /** @type {Row} */ (message).content : undefined;
  if (typeof content === 'string') return promptOrNull(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const text = promptOrNull(block.text);
      if (text) return text;
    }
  }
  return null;
}

/**
 * @param {string|null} recorded
 * @param {string} projectCwd Normalized absolute project cwd.
 */
function sameCwd(recorded, projectCwd) {
  return typeof recorded === 'string' && path.isAbsolute(recorded) && path.resolve(recorded) === projectCwd;
}

/**
 * One pass over a head window. Returns as soon as the first recorded cwd is
 * known when `cwdOnly`, or when that cwd is not the project's. Once the early
 * facts are in, only lines that can be title / last-prompt rows are parsed.
 * @param {Buffer} head
 * @param {string} projectCwd
 * @param {boolean} cwdOnly
 * @returns {TranscriptFacts}
 */
function scanHead(head, projectCwd, cwdOnly) {
  /** @type {TranscriptFacts} */
  const facts = { recordedCwd: null, firstPrompt: null, entrypoint: null, gitBranch: null, lastPrompt: '', customTitle: '', summary: '' };
  for (const line of completeLines(head, false)) {
    const early = facts.recordedCwd === null || facts.firstPrompt === null || facts.entrypoint === null || facts.gitBranch === null;
    if (!early && !mayBeLateRow(line)) continue;
    const row = parseRow(line);
    if (!row) continue;
    if (facts.recordedCwd === null && typeof row.cwd === 'string') {
      facts.recordedCwd = row.cwd;
      if (cwdOnly || !sameCwd(row.cwd, projectCwd)) return facts;
    }
    if (facts.entrypoint === null && typeof row.entrypoint === 'string') facts.entrypoint = row.entrypoint;
    if (facts.gitBranch === null && typeof row.gitBranch === 'string') facts.gitBranch = clip(row.gitBranch);
    if (facts.firstPrompt === null) facts.firstPrompt = userPromptText(row);
    noteLateRow(row, facts);
  }
  return facts;
}

/**
 * Fold a tail window's title / last-prompt rows into `facts`; they are the
 * file's latest, so they override the head's.
 * @param {Buffer} tail
 * @param {TranscriptFacts} facts
 */
function scanTail(tail, facts) {
  for (const line of completeLines(tail, true)) {
    if (!mayBeLateRow(line)) continue;
    const row = parseRow(line);
    if (row) noteLateRow(row, facts);
  }
}

/**
 * Picker fields for one transcript, or null when it is not restorable here
 * (foreign or missing cwd, no real prompt in the head, unreadable). The tail is
 * read only for a keeper larger than the head window.
 * @param {string} file
 * @param {number} size Size from the walk's stat.
 * @param {string} projectCwd
 * @param {{ head: Buffer, tail: Buffer }} bufs Reused across the sequential walk.
 * @returns {Promise<Omit<RestorableSession, 'sessionId'|'mtimeMs'|'sizeBytes'|'recentlyActive'>|null>}
 */
async function inspectTranscript(file, size, projectCwd, bufs) {
  /** @type {import('node:fs/promises').FileHandle|undefined} */
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { bytesRead } = await fh.read(bufs.head, 0, HEAD_BYTES, 0);
    const facts = scanHead(bufs.head.subarray(0, bytesRead), projectCwd, false);
    if (!sameCwd(facts.recordedCwd, projectCwd) || !facts.firstPrompt) return null;
    if (size > HEAD_BYTES) {
      const tail = await fh.read(bufs.tail, 0, TAIL_BYTES, size - TAIL_BYTES);
      scanTail(bufs.tail.subarray(0, tail.bytesRead), facts);
    }
    return {
      title: facts.customTitle || facts.summary || null,
      firstPrompt: facts.firstPrompt,
      lastPrompt: facts.lastPrompt || null,
      gitBranch: facts.gitBranch || null,
      headless: typeof facts.entrypoint === 'string' && facts.entrypoint.startsWith('sdk-'),
    };
  } catch {
    return null; // vanished or unreadable mid-walk
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** @param {string} name */
function isTranscriptName(name) {
  return name.endsWith(JSONL) && SESSION_ID_RE.test(name.slice(0, -JSONL.length));
}

/**
 * Regular-file transcripts among `names`, stat'ed with bounded concurrency so a
 * 1,500-file dir does not flood libuv's threadpool.
 * @param {string} dir
 * @param {string[]} names Already filtered to `<uuid>.jsonl`.
 * @returns {Promise<Candidate[]>}
 */
async function statCandidates(dir, names) {
  /** @type {Candidate[]} */
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        if (st.isFile()) out.push({ name, sessionId: name.slice(0, -JSONL.length), mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, names.length) }, worker));
  return out;
}

/**
 * CLI sessions in this project's transcript dir that no Epic owns, newest
 * first, for the "Restore a session" picker. Reads only that one dir; a
 * missing dir lists nothing. Never throws (the `{ cwd: '' }` default makes a
 * bare call list nothing).
 * @param {{ cwd: string, limit?: number, deps?: RestorableDeps }} opts
 * @returns {Promise<RestorableList>}
 */
async function listRestorableSessions({ cwd, limit = DEFAULT_LIMIT, deps } = { cwd: '' }) {
  /** @type {RestorableList} */
  const result = { sessions: [], hiddenClaimed: 0, scanned: 0, truncated: false };
  const projectCwd = normalizeCwd(cwd);
  if (!projectCwd) return result;
  const d = deps || {};
  const dir = projectDirOf(projectCwd, d);
  /** @type {string[]} */
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return result; // no CLI history for this project
  }
  const candidates = await statCandidates(dir, names.filter(isTranscriptName));
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

  const claimed = lowerSet(claimedClaudeSessionIds(projectCwd, d));
  /** @type {Candidate[]} */
  const open = [];
  for (const c of candidates) {
    if (claimed.has(c.sessionId.toLowerCase())) result.hiddenClaimed += 1;
    else open.push(c);
  }

  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_HEAD_READS) : DEFAULT_LIMIT;
  const now = d.now ? d.now() : Date.now();
  const bufs = { head: Buffer.allocUnsafe(HEAD_BYTES), tail: Buffer.allocUnsafe(TAIL_BYTES) };
  let i = 0;
  for (; i < open.length; i += 1) {
    if (result.sessions.length >= max || result.scanned >= MAX_HEAD_READS) break;
    const c = open[i];
    result.scanned += 1;
    const fields = await inspectTranscript(path.join(dir, c.name), c.sizeBytes, projectCwd, bufs);
    if (!fields) continue;
    result.sessions.push({
      sessionId: c.sessionId,
      title: fields.title,
      firstPrompt: fields.firstPrompt,
      lastPrompt: fields.lastPrompt,
      gitBranch: fields.gitBranch,
      headless: fields.headless,
      mtimeMs: c.mtimeMs,
      sizeBytes: c.sizeBytes,
      recentlyActive: now - c.mtimeMs < RECENT_MS,
    });
  }
  result.truncated = i < open.length;
  return result;
}

/**
 * First ≤ 64 KiB of `file`, through a fixed buffer.
 * @param {string} file
 * @returns {Buffer}
 */
function readHeadSync(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {RefusalCode} code
 * @param {string} message
 * @returns {RestorableRefusal}
 */
function refuse(code, message) {
  return { ok: false, code, message };
}

/** @param {unknown} id */
function showId(id) {
  if (typeof id !== 'string') return `(${id === null ? 'null' : typeof id})`;
  return JSON.stringify(id.length > 80 ? `${id.slice(0, 80)}…` : id);
}

/**
 * Can `sessionId` be adopted by a new Epic of this project? The single-id gate
 * for the mint path: id format first (before any path exists), then the
 * transcript file, its recorded cwd, and Epic ownership.
 * @param {string} cwd Project cwd (absolute).
 * @param {string} sessionId
 * @param {RestorableDeps} [deps]
 * @returns {RestorableOk|RestorableRefusal}
 */
function checkRestorableSessionSync(cwd, sessionId, deps) {
  const d = deps || {};
  const valid = typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
  const projectCwd = normalizeCwd(cwd);
  if (!valid) {
    const where = projectCwd ? projectDirOf(projectCwd, d) : 'any project dir';
    return refuse('invalid_id', `Refused session id ${showId(sessionId)} for ${where}: not a Claude session UUID, so no path was built from it.`);
  }
  if (!projectCwd) {
    return refuse('not_found', `Cannot look up session ${sessionId}: project cwd ${showId(cwd)} is not an absolute path, so there is no project dir to search.`);
  }
  const dir = projectDirOf(projectCwd, d);
  const transcriptPath = path.join(dir, `${sessionId}${JSONL}`);
  let isFile = false;
  try {
    isFile = fs.statSync(transcriptPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return refuse('not_found', `No CLI transcript for session ${sessionId} in ${dir}.`);

  /** @type {string|null} */
  let recordedCwd = null;
  try {
    recordedCwd = scanHead(readHeadSync(transcriptPath), projectCwd, true).recordedCwd;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refuse('not_found', `Session ${sessionId} in ${dir} could not be read: ${why}`);
  }
  if (!sameCwd(recordedCwd, projectCwd)) {
    return refuse('cwd_mismatch', recordedCwd === null
      ? `Session ${sessionId} in ${dir} records no cwd in its first 64 KiB, so it cannot be shown to belong to ${projectCwd}.`
      : `Session ${sessionId} in ${dir} was recorded in ${recordedCwd}, not ${projectCwd}.`);
  }
  if (lowerSet(claimedClaudeSessionIds(projectCwd, d)).has(sessionId.toLowerCase())) {
    return refuse('claimed', `Session ${sessionId} in ${dir} already belongs to an Epic in this project.`);
  }
  return { ok: true, transcriptPath };
}

module.exports = {
  SESSION_ID_RE,
  claimedClaudeSessionIds,
  listRestorableSessions,
  checkRestorableSessionSync,
  __resetCacheForTests,
};
