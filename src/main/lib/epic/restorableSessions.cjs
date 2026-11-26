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
 *   - head-reads at most 400 transcripts per call, newest first, and reports
 *     `truncated` when unread candidates remained;
 *   - fills two budgets of `limit` rows, interactive and headless, so a headless
 *     row never takes an interactive row's place. Per-kind budgets exist because
 *     a project with claude -p automation has ~98% headless transcripts: one
 *     shared budget listed 48 headless + 2 interactive rows on this repo;
 *   - memoises the claimed-id scan per cwd on each ops file's stat key (keyOf), so
 *     an unchanged Epic file is never re-read (epicTranscriptPath.cjs's shape).
 *     The list path scans through fs.promises (claimedClaudeSessionIdsAsync): a
 *     cold scan reads every archived Epic file, which blocked 191 ms when sync.
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
const { readActiveIndex } = require('./epicMint.cjs');

/** A Claude Code session id: hex UUID 8-4-4-4-12, either case. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_HEAD_READS = 400;
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
 * @property {RestorableSession[]} sessions Newest first by mtime. The limit is per kind: up to `limit`
 *   interactive rows plus, on a separate budget, up to `limit` headless rows.
 * @property {number} hiddenClaimed Transcripts left out because an Epic owns them.
 * @property {number} scanned Transcript heads read by this call (at most 400).
 * @property {boolean} truncated Unread unclaimed candidates remained: the walk stopped with both per-kind
 *   budgets full, or at the 400-read cap.
 */

/** @typedef {'invalid_id'|'not_found'|'cwd_mismatch'|'claimed'|'claim_check_unreadable'} RefusalCode */
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

/**
 * One cwd's claimed-id memo. The sync and the async reader both read and write it.
 * Completeness is not stored here: each scan returns its own (ClaimScan), so a
 * concurrent scan of the same cwd overwriting this entry cannot change what
 * another scan's caller acts on.
 * @typedef {{ indexKey: string, indexIds: string[], files: Map<string, ArchiveRec> }} ClaimedEntry
 */

/**
 * One claim scan's result. `incomplete`: an archived Epic file could not be
 * read even on retry during this scan, so `ids` may miss a claim.
 * @typedef {{ ids: Set<string>, incomplete: boolean }} ClaimScan
 */

/** @type {Map<string, ClaimedEntry>} */
const claimedCache = new Map();

function __resetCacheForTests() {
  claimedCache.clear();
}

/**
 * The memo key. One formatter for both stat paths, so each reader can reuse
 * the records the other wrote.
 *
 * mtimeMs:size alone served stale ids: a rewrite that swaps one claudeSessionId
 * for another is always the same size (UUIDs are fixed-length), and it keeps
 * its mtime when it lands within one timestamp tick (coarse-mtime filesystems)
 * or has its mtime restored. dev:ino changes on every tmp+rename write (how
 * atomicFs writes Epic files), and ctime moves on every write and can't be
 * set back from user space.
 * @param {import('node:fs').Stats} s
 * @returns {string} `dev:ino:ctimeMs:mtimeMs:size`
 */
function keyOf(s) {
  return `${s.dev}:${s.ino}:${s.ctimeMs}:${s.mtimeMs}:${s.size}`;
}

/**
 * @param {string} file
 * @returns {string} keyOf(stat), or 'missing'
 */
function statKey(file) {
  try {
    return keyOf(fs.statSync(file));
  } catch {
    return 'missing';
  }
}

/**
 * statKey through fs.promises.
 * @param {string} file
 * @returns {Promise<string>} keyOf(stat), or 'missing'
 */
async function statKeyAsync(file) {
  try {
    return keyOf(await fs.promises.stat(file));
  } catch {
    return 'missing';
  }
}

/**
 * Run `task(0)` … `task(count - 1)` with at most 16 in flight, so a dir of
 * 1,500 files does not flood libuv's threadpool. `task` must not reject.
 * @param {number} count
 * @param {(index: number) => Promise<void>} task
 * @returns {Promise<void>}
 */
async function forEachBounded(count, task) {
  let next = 0;
  const worker = async () => {
    while (next < count) await task(next++);
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, count) }, worker));
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

const ACTIVE_INDEX = 'active-index.json';

/**
 * This cwd's prompt-sessions dir, or null when the cwd has no ops root
 * (relative, tmpdir or linked worktree) and so cannot hold Epics.
 * @param {unknown} cwd
 * @returns {string|null}
 */
function promptSessionsDirOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    // Lazy, as in epicMint.cjs: opsOwnership → ephemeralCwd → activeSessions.
    const { opsPath } = require('../opsOwnership.cjs');
    return opsPath(cwd, 'prompt-sessions');
  } catch {
    return null;
  }
}

/**
 * claudeSessionIds in active-index.json: one small file, read through
 * readActiveIndex by both readers.
 * @param {string} cwd
 * @param {RestorableDeps} d
 * @returns {string[]}
 */
function readIndexIds(cwd, d) {
  /** @type {Record<string, unknown>} */
  let sessions = {};
  try {
    sessions = (d.readActiveIndex || readActiveIndex)(cwd).sessions || {};
  } catch {
    sessions = {};
  }
  /** @type {string[]} */
  const out = [];
  for (const s of Object.values(sessions)) {
    const sid = sessionIdOf(s);
    if (sid) out.push(sid);
  }
  return out;
}

/** @param {string} name An archived Epic file: any `.json` but the index. */
function isArchiveName(name) {
  return name.endsWith('.json') && name !== ACTIVE_INDEX;
}

/**
 * First half of the per-file archive-record update both readers share: the
 * memo's record while the file's stat key is unchanged, else null.
 * @param {Map<string, ArchiveRec>} prevFiles
 * @param {string} name
 * @param {string} key
 * @returns {ArchiveRec|null}
 */
function memoHit(prevFiles, name, key) {
  const hit = prevFiles.get(name);
  return hit && hit.key === key ? hit : null;
}

/** A record key no stat key equals, so memoHit never serves it. */
const UNREAD_KEY = 'unread';

/**
 * One read of an archived Epic file: `{ io: true }` when the read itself
 * failed (EMFILE, EACCES, EIO…), else `{ doc }` with `doc` null for an empty
 * file, invalid JSON or a non-object. A file gone since readdir (ENOENT) owns
 * nothing, so it reads as `{ doc: null }`: atomicFs writes by tmp+rename, which
 * never leaves the target missing. Not atomicFs.readJsonOr*: they return the
 * fallback for both a parse error and an I/O error. Goes through the `fs`
 * module object so tests can spy on readFileSync / promises.readFile.
 * @typedef {{ io: true } | { io?: false, doc: object|null }} ArchiveRead
 */

/**
 * @param {string} raw
 * @returns {ArchiveRead}
 */
function parseArchive(raw) {
  if (raw.trim() === '') return { doc: null };
  try {
    const doc = JSON.parse(raw);
    return { doc: doc && typeof doc === 'object' ? doc : null };
  } catch {
    return { doc: null };
  }
}

/** @param {unknown} err */
function isGone(err) {
  return !!err && typeof err === 'object' && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT';
}

/**
 * @param {string} file
 * @returns {ArchiveRead}
 */
function readArchiveSync(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return isGone(err) ? { doc: null } : { io: true };
  }
  return parseArchive(raw);
}

/**
 * @param {string} file
 * @returns {Promise<ArchiveRead>}
 */
async function readArchiveAsync(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    return isGone(err) ? { doc: null } : { io: true };
  }
  return parseArchive(raw);
}

/**
 * Second half: the record for an archived Epic file read at `key`, from the
 * result of reading it and (after an I/O failure) of reading it once more.
 * Three cases:
 *  - parsed to an object: its session's claudeSessionId, memoised under `key`;
 *  - read fine but empty, invalid JSON or not an object: owns nothing, and
 *    that is memoised under `key` too, so an unchanged bad file is not re-read
 *    on every call (a rewrite changes the stat key and is read again);
 *  - the read failed twice (`io`): owns nothing for this call, gets UNREAD_KEY
 *    so the next call re-reads it, and `onUnreadable` marks the scan
 *    incomplete. Memoising it under the file's unchanged stat key would drop
 *    that Epic's claim until the file is next rewritten, and using the set
 *    without the claim would list or restore an Epic-owned session (breaks
 *    Epic:session = 1:1), so consumers fail closed on an incomplete scan.
 * @param {string} key
 * @param {ArchiveRead} read
 * @param {() => void} onUnreadable
 * @returns {ArchiveRec}
 */
function archiveRec(key, read, onUnreadable) {
  if (read.io) {
    onUnreadable();
    return { key: UNREAD_KEY, sid: null };
  }
  const { doc } = read;
  if (!doc) return { key, sid: null };
  return { key, sid: sessionIdOf(/** @type {Row} */ (doc).session) };
}

/**
 * Store `entry` as `cwd`'s memo and return the ids it claims.
 * @param {string} cwd
 * @param {ClaimedEntry} entry
 * @returns {Set<string>}
 */
function commitClaimed(cwd, entry) {
  claimedCache.set(cwd, entry);
  /** @type {Set<string>} */
  const ids = new Set(entry.indexIds);
  for (const rec of entry.files.values()) if (rec.sid) ids.add(rec.sid);
  return ids;
}

/**
 * Every claudeSessionId an Epic of this project owns: active-index.json plus
 * each archived prompt-sessions/<id>.json. Memoised per cwd on each file's
 * stat key (keyOf), so an unchanged file is never re-read (one statSync per file per
 * call); the memo is shared with claimedClaudeSessionIdsAsync. A cwd with no ops
 * root (relative, tmpdir or linked worktree) cannot hold Epics, so it owns
 * nothing. Sync, for the mint gate (checkRestorableSessionSync).
 * @param {string} cwd Project cwd (mapped to its ops root by opsPath).
 * @param {RestorableDeps} [deps]
 * @returns {Set<string>}
 */
function claimedClaudeSessionIds(cwd, deps) {
  return scanClaimedSync(cwd, deps).ids;
}

/**
 * claimedClaudeSessionIds plus this scan's own completeness.
 * @param {string} cwd
 * @param {RestorableDeps} [deps]
 * @returns {ClaimScan}
 */
function scanClaimedSync(cwd, deps) {
  const dir = promptSessionsDirOf(cwd);
  if (!dir) return { ids: new Set(), incomplete: false };
  const d = deps || {};
  const prev = claimedCache.get(cwd);
  const indexKey = statKey(path.join(dir, ACTIVE_INDEX));
  const indexIds = prev && prev.indexKey === indexKey ? prev.indexIds : readIndexIds(cwd, d);
  const prevFiles = prev ? prev.files : new Map();
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(isArchiveName);
  } catch {
    names = [];
  }
  /** @type {Map<string, ArchiveRec>} */
  const files = new Map();
  let incomplete = false;
  const markIncomplete = () => { incomplete = true; };
  for (const name of names) {
    const file = path.join(dir, name);
    const key = statKey(file);
    const hit = memoHit(prevFiles, name, key);
    if (hit) {
      files.set(name, hit);
      continue;
    }
    let read = readArchiveSync(file);
    if (read.io) read = readArchiveSync(file); // one immediate retry
    files.set(name, archiveRec(key, read, markIncomplete));
  }
  return { ids: commitClaimed(cwd, { indexKey, indexIds, files }), incomplete };
}

/**
 * claimedClaudeSessionIds through fs.promises (readdir, stat and readFile, at
 * most 16 files in flight), for the list path. A cold scan reads every archived
 * Epic file; done sync it blocked the main loop for 191 ms. Same memo as the
 * sync reader, so either one re-reads only the files whose stat key changed
 * since the last scan by either. active-index.json stays a readActiveIndex read,
 * memoised on its own key as in the sync reader.
 * @param {string} cwd Project cwd (mapped to its ops root by opsPath).
 * @param {RestorableDeps} [deps]
 * @returns {Promise<Set<string>>}
 */
async function claimedClaudeSessionIdsAsync(cwd, deps) {
  return (await scanClaimedAsync(cwd, deps)).ids;
}

/**
 * claimedClaudeSessionIdsAsync plus this scan's own completeness.
 * @param {string} cwd
 * @param {RestorableDeps} [deps]
 * @returns {Promise<ClaimScan>}
 */
async function scanClaimedAsync(cwd, deps) {
  const dir = promptSessionsDirOf(cwd);
  if (!dir) return { ids: new Set(), incomplete: false };
  const d = deps || {};
  const prev = claimedCache.get(cwd);
  const indexKey = await statKeyAsync(path.join(dir, ACTIVE_INDEX));
  const indexIds = prev && prev.indexKey === indexKey ? prev.indexIds : readIndexIds(cwd, d);
  const prevFiles = prev ? prev.files : new Map();
  /** @type {string[]} */
  let names = [];
  try {
    names = (await fs.promises.readdir(dir)).filter(isArchiveName);
  } catch {
    names = [];
  }
  /** @type {ArchiveRec[]} */
  const recs = new Array(names.length);
  let incomplete = false;
  const markIncomplete = () => { incomplete = true; };
  await forEachBounded(names.length, async (k) => {
    const file = path.join(dir, names[k]);
    const key = await statKeyAsync(file);
    const hit = memoHit(prevFiles, names[k], key);
    if (hit) {
      recs[k] = hit;
      return;
    }
    let read = await readArchiveAsync(file);
    if (read.io) read = await readArchiveAsync(file); // one immediate retry
    recs[k] = archiveRec(key, read, markIncomplete);
  });
  /** @type {Map<string, ArchiveRec>} */
  const files = new Map();
  names.forEach((name, k) => files.set(name, recs[k])); // readdir order, as the sync reader
  return { ids: commitClaimed(cwd, { indexKey, indexIds, files }), incomplete };
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
 * Regular-file transcripts among `names`, stat'ed with bounded concurrency
 * (forEachBounded) so a 1,500-file dir does not flood libuv's threadpool.
 * @param {string} dir
 * @param {string[]} names Already filtered to `<uuid>.jsonl`.
 * @returns {Promise<Candidate[]>}
 */
async function statCandidates(dir, names) {
  /** @type {Candidate[]} */
  const out = [];
  await forEachBounded(names.length, async (k) => {
    const name = names[k];
    try {
      const st = await fs.promises.stat(path.join(dir, name));
      if (st.isFile()) out.push({ name, sessionId: name.slice(0, -JSONL.length), mtimeMs: st.mtimeMs, sizeBytes: st.size });
    } catch {
      // vanished between readdir and stat
    }
  });
  return out;
}

/**
 * CLI sessions in this project's transcript dir that no Epic owns, newest
 * first, for the "Restore a session" picker. The limit is per kind: up to
 * `limit` interactive rows and, on a separate budget, up to `limit` headless
 * rows, so a headless run never takes an interactive row's place. The walk
 * stops once both budgets are full or after 400 head reads. Reads only that one
 * dir; a missing dir lists nothing. Never throws (the `{ cwd: '' }` default
 * makes a bare call list nothing).
 * @param {{ cwd: string, limit?: number, deps?: RestorableDeps }} opts `limit` is per kind
 *   (default 50, at most 400).
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

  const scan = await scanClaimedAsync(projectCwd, d);
  // An Epic file that could not be read may own any candidate: list nothing
  // for this call rather than offer an Epic-owned session. The next call retries.
  // Decided from this scan's own result, never the shared memo (a concurrent
  // scan of this cwd may have overwritten it during the await).
  if (scan.incomplete) return result;
  const claimed = lowerSet(scan.ids);
  /** @type {Candidate[]} */
  const open = [];
  for (const c of candidates) {
    if (claimed.has(c.sessionId.toLowerCase())) result.hiddenClaimed += 1;
    else open.push(c);
  }

  const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_HEAD_READS) : DEFAULT_LIMIT;
  const now = d.now ? d.now() : Date.now();
  const bufs = { head: Buffer.allocUnsafe(HEAD_BYTES), tail: Buffer.allocUnsafe(TAIL_BYTES) };
  // Only a head says which kind a row is, so a full budget drops that kind's
  // later rows while the walk reads on for the other kind.
  let interactive = 0;
  let headless = 0;
  let i = 0;
  for (; i < open.length; i += 1) {
    if ((interactive >= max && headless >= max) || result.scanned >= MAX_HEAD_READS) break;
    const c = open[i];
    result.scanned += 1;
    const fields = await inspectTranscript(path.join(dir, c.name), c.sizeBytes, projectCwd, bufs);
    if (!fields || (fields.headless ? headless : interactive) >= max) continue;
    if (fields.headless) headless += 1;
    else interactive += 1;
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

const RECENT_READ_CONCURRENCY = 4;

/**
 * @typedef {object} RecentRestorableDeps
 * @property {(opts?: object) => string[]} [allProjectCwds] Project cwds (default activeSessions' cached allProjectCwds).
 * @property {typeof listRestorableSessions} [listRestorableSessions] Per-project lister (test seam).
 */

/**
 * Transcript-folder mtime of each of `cwds`, newest first; a folder that
 * cannot be stat'ed is dropped (no CLI history there).
 * @param {string[]} cwds
 * @param {RestorableDeps} d
 * @returns {Promise<string[]>}
 */
async function byFolderActivity(cwds, d) {
  const stamped = await Promise.all(cwds.map(async (cwd, i) => {
    try {
      return { cwd, i, mtimeMs: (await fs.promises.stat(projectDirOf(cwd, d))).mtimeMs };
    } catch {
      return null;
    }
  }));
  return /** @type {{ cwd: string, i: number, mtimeMs: number }[]} */ (stamped.filter(Boolean))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.i - b.i)
    .map((s) => s.cwd);
}

/**
 * Interactive restorable sessions across this machine's projects, newest
 * first, each tagged with its project `cwd` — for a "continue any session"
 * picker. Bounded like listRestorableSessions: the project list comes from
 * activeSessions' cached allProjectCwds() (never a fresh ~/.claude/projects
 * walk), at most `maxProjects * 2` transcript folders are stat'ed to rank them
 * by activity, at most `maxProjects` are read (4 at a time) through
 * listRestorableSessions({ cwd, limit: perProject }), which also hides
 * Epic-owned sessions. A project whose read fails is skipped. Never throws.
 * @param {{ limit?: number, maxProjects?: number, perProject?: number, deps?: RestorableDeps & RecentRestorableDeps }} [opts]
 * @returns {Promise<{ sessions: (RestorableSession & { cwd: string })[], projectsRead: number, truncated: boolean }>}
 */
async function listRecentRestorableSessions({ limit = 30, maxProjects = 25, perProject = 5, deps } = {}) {
  /** @type {{ sessions: (RestorableSession & { cwd: string })[], projectsRead: number, truncated: boolean }} */
  const result = { sessions: [], projectsRead: 0, truncated: false };
  const d = deps || {};
  const cap = (/** @type {number} */ n, /** @type {number} */ dflt) => (Number.isInteger(n) && n > 0 ? n : dflt);
  const maxP = cap(maxProjects, 25);
  const max = cap(limit, 30);
  const per = cap(perProject, 5);
  const lister = d.listRestorableSessions || listRestorableSessions;
  /** @type {string[]} */
  let all;
  try {
    const source = d.allProjectCwds || require('../activeSessions.cjs').allProjectCwds;
    const raw = source();
    all = Array.isArray(raw) ? [...new Set(raw.map((c) => normalizeCwd(c)).filter(Boolean))] : [];
  } catch {
    return result;
  }
  const ranked = await byFolderActivity(all.slice(0, maxP * 2), d);
  const picked = ranked.slice(0, maxP);
  if (all.length > maxP * 2 || ranked.length > maxP) result.truncated = true;

  /** @type {(RestorableSession & { cwd: string })[]} */
  const merged = [];
  let next = 0;
  const worker = async () => {
    while (next < picked.length) {
      const cwd = picked[next];
      next += 1;
      try {
        const r = await lister({ cwd, limit: per, deps: d });
        result.projectsRead += 1;
        if (r.truncated) result.truncated = true;
        for (const s of r.sessions) if (!s.headless) merged.push({ ...s, cwd });
      } catch {
        // unreadable project: skip it
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECENT_READ_CONCURRENCY, picked.length) }, worker));

  merged.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  if (merged.length > max) result.truncated = true;
  result.sessions = merged.slice(0, max);
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
  const scan = scanClaimedSync(projectCwd, d);
  const claimed = lowerSet(scan.ids);
  if (scan.incomplete) {
    return refuse('claim_check_unreadable', `Cannot restore session ${sessionId} in ${dir} yet: the claim check could not read an Epic file in ${projectCwd}, so it cannot rule out that an Epic already owns this session. Try again.`);
  }
  if (claimed.has(sessionId.toLowerCase())) {
    return refuse('claimed', `Session ${sessionId} in ${dir} already belongs to an Epic in this project.`);
  }
  return { ok: true, transcriptPath };
}

module.exports = {
  SESSION_ID_RE,
  keyOf,
  claimedClaudeSessionIds,
  claimedClaudeSessionIdsAsync,
  listRestorableSessions,
  listRecentRestorableSessions,
  checkRestorableSessionSync,
  showId,
  __resetCacheForTests,
};
