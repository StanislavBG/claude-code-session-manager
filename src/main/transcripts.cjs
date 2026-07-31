/**
 * TranscriptsManager — tails Claude Code session JSONL files and emits
 * structured events to the renderer.
 *
 * Transcript path convention (Apr 2026):
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * cwd encoding: every non-alphanumeric char → '-' (literal regex
 * /[^a-zA-Z0-9]/g → '-').
 *
 * Deterministic mapping: renderer passes `--session-id <tab-uuid>` when
 * launching `claude`. This manager expects that same UUID as the file's
 * basename. Consumers subscribe per (tabId, cwd, sessionUuid) triple.
 *
 * Each subscription opens a single chokidar watcher on the directory and
 * streams new bytes from the matching file, splits on newlines, zod-passes
 * each line through a lax schema, then forwards typed events.
 */

const { ipcMain } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const chokidar = require('chokidar');
const otel = require('./otel.cjs');
const logs = require('./logs.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

let window = null;

/** Map<tabId, Subscription> */
const subs = new Map();

function attachWindow(w) {
  window = w;
}

const { encodeCwd } = require('./lib/encodeCwd.cjs');
const { classifyLine } = require('./lib/classifyTranscriptLine.cjs');

function transcriptPath(cwd, sessionUuid) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionUuid}.jsonl`);
}

// Cap bytes read per readDelta pass. Bounds memory on first attach to a very
// large transcript (hundreds of MB) — see readDelta's seek-to-tail branch.
const MAX_DELTA_BYTES = 8 * 1024 * 1024;

/**
 * Read new bytes from sub.filePath into sub.offset/pending/inode in place.
 * Resets offset+pending when the file inode changes (rename+replace rotation).
 * Returns parsed line strings ready for JSON.parse.
 */
async function readDelta(sub) {
  const stat = await fsp.stat(sub.filePath).catch(() => null);
  if (!stat) return [];
  // Inode changed → file was replaced underfoot; restart from the top.
  if (sub.inode !== undefined && stat.ino !== sub.inode) {
    sub.offset = 0;
    sub.pending = '';
  }
  if (stat.size < sub.offset) {
    // File was truncated/rotated — start over.
    sub.offset = 0;
    sub.pending = '';
  }
  if (stat.size === sub.offset) {
    sub.inode = stat.ino;
    return [];
  }
  let readFrom = sub.offset;
  let length = stat.size - readFrom;
  let skipped = false;
  if (length > MAX_DELTA_BYTES) {
    // Huge unread span — typically a very large transcript (hundreds of MB) on
    // first attach. Materializing the whole thing into a Buffer + decoded string
    // can OOM-kill the main process, so seek to the last MAX_DELTA_BYTES and
    // ring-buffer only the most recent events (bounded at 500 anyway).
    readFrom = stat.size - MAX_DELTA_BYTES;
    // Include the byte just before the window so the first split segment we drop
    // below is always either an empty string (if the window began exactly at a
    // newline) or a genuine partial line — never a complete event.
    if (readFrom > 0) readFrom -= 1;
    length = stat.size - readFrom;
    sub.pending = '';
    skipped = true;
  }
  const fd = await fsp.open(sub.filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, readFrom);
    const text = sub.pending + buf.toString('utf8');
    const parts = text.split('\n');
    sub.pending = parts.pop() ?? '';
    if (skipped) parts.shift(); // discard the partial line at the seek boundary
    sub.offset = stat.size;
    sub.inode = stat.ino;
    return parts.filter(Boolean);
  } finally {
    await fd.close();
  }
}

async function doFlush(sub, { emit = true } = {}) {
  const lines = await readDelta(sub);
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = classifyLine(obj);
    if (!ev) continue;
    // Ring buffer (cap at 500 entries to bound memory).
    sub.buffer.push(ev);
    if (sub.buffer.length > 500) sub.buffer.shift();
    if (emit) sendIfAlive(window, `transcript:event:${sub.tabId}`, ev);
    // Mirror to OTEL — no-op when disabled. We emit on the initial drain too
    // so backfilled transcripts show up in the trace store.
    otel.recordTranscriptEvent({
      tabId: sub.tabId,
      tabCwd: sub.cwd,
      kind: ev.kind,
      data: ev.data,
      ts: Date.now(),
    });
  }
}

// Serialised flush scheduler — at most one readDelta per sub in flight at a
// time. Uses a dirty flag for trailing-edge re-run: if a chokidar event fires
// while a flush is in progress, dirty stays true and the loop runs one more
// time after the current read completes, guaranteeing no event is dropped.
function scheduleFlush(sub) {
  sub.dirty = true;
  if (sub.flushing) return sub.flushing;
  sub.flushing = (async () => {
    while (sub.dirty) {
      sub.dirty = false;
      await doFlush(sub);
    }
  })()
    .catch((e) => {
      logs.writeLine({ level: 'warn', scope: 'transcripts', message: 'flush error', meta: { error: e?.message } });
    })
    .finally(() => {
      sub.flushing = null;
    });
  return sub.flushing;
}

const MAX_TRANSCRIPT_SUBS = 20;

/**
 * LRU pool of released-but-cached subscriptions. When a renderer consumer
 * calls release(), the sub stays alive (offset + buffer preserved) so a
 * subsequent tab-switch back resumes from the current offset instead of
 * re-reading the entire transcript from byte 0. Oldest entries are evicted
 * once the pool exceeds LRU_CAP.
 */
const LRU_CAP = 6;
const lruReleased = []; // tabIds with no active consumer, ordered oldest→newest

function _closeSub(tabId) {
  const sub = subs.get(tabId);
  if (!sub) return;
  sub.watcher?.close().catch(() => {});
  subs.delete(tabId);
  const i = lruReleased.indexOf(tabId);
  if (i !== -1) lruReleased.splice(i, 1);
}

/**
 * release(tabId) — called when the renderer's last consumer unmounts (view
 * switch). Keeps the sub alive in the LRU cache so a quick revisit resumes
 * from the persisted offset. Evicts the oldest cached sub if over LRU_CAP.
 */
function release(tabId) {
  if (!subs.has(tabId)) return;
  if (!lruReleased.includes(tabId)) {
    lruReleased.push(tabId);
  }
  while (lruReleased.length > LRU_CAP) {
    const oldest = lruReleased.shift();
    _closeSub(oldest);
  }
}

/** closeTab(tabId) — genuine tab close; always destroys the sub immediately. */
function closeTab(tabId) {
  _closeSub(tabId);
}

async function subscribe({ tabId, cwd, sessionUuid }) {
  if (subs.has(tabId)) {
    // Tab is in the LRU cache — promote it back to active.
    const i = lruReleased.indexOf(tabId);
    if (i !== -1) lruReleased.splice(i, 1);
    return { ok: true, path: subs.get(tabId).filePath };
  }
  if (subs.size >= MAX_TRANSCRIPT_SUBS) {
    // Before rejecting a genuinely new subscription, evict an idle LRU-cached
    // entry — it occupies a slot but has no active consumer. Only reject if no
    // idle entries are available to free.
    if (lruReleased.length > 0) {
      _closeSub(lruReleased[0]);
    }
  }
  if (subs.size >= MAX_TRANSCRIPT_SUBS) {
    logs.writeLine({
      level: 'warn',
      scope: 'transcripts',
      message: 'subscribe rejected: at cap',
      meta: { tabId, cap: MAX_TRANSCRIPT_SUBS, cwd },
    });
    return { ok: false, path: null, error: 'too many active subscriptions' };
  }
  const filePath = transcriptPath(cwd, sessionUuid);
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  const sub = {
    tabId,
    cwd,
    sessionUuid,
    filePath,
    offset: 0,
    pending: '',
    buffer: [],
    watcher: null,
    flushing: null,
    dirty: false,
  };
  // If the file already exists, read current content as replay. Do not emit
  // during this initial drain — the renderer drains sub.buffer via
  // `transcript:buffer` after `transcript:subscribe` resolves. Emitting here
  // would race the renderer's onEvent listener registration and drop events.
  if (fs.existsSync(filePath)) {
    await doFlush(sub, { emit: false });
  }
  const watcher = chokidar.watch(filePath, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 20 },
  });
  watcher.on('add', () => scheduleFlush(sub));
  watcher.on('change', () => scheduleFlush(sub));
  watcher.on('error', (err) => logs.writeLine({ level: 'warn', scope: 'transcripts', message: 'chokidar watcher error', meta: { error: err?.message } }));
  sub.watcher = watcher;
  subs.set(tabId, sub);
  return { ok: true, path: filePath };
}

/** @deprecated Use release() for view-switch, closeTab() for genuine close. */
function unsubscribe(tabId) {
  release(tabId);
}

function getBuffer(tabId) {
  const sub = subs.get(tabId);
  return sub ? sub.buffer.slice() : [];
}

// Cap on the transcript file we'll fully re-read for a token-usage summary —
// protects against OOM on a pathologically large transcript. Sessions over
// this size report null (omitted by the renderer) rather than a partial sum.
const MAX_USAGE_FILE_BYTES = 64 * 1024 * 1024;

/** Map<filePath, { mtimeMs, size, usage: {inputTokens, outputTokens} }> */
const usageCache = new Map();

/**
 * Sum `usage` events out of one session's JSONL transcript — same
 * classifyLine()/field-name resolution live.ts's ingest uses for its running
 * per-tab totals (input_tokens/output_tokens, snake_case on the wire).
 * Cached by file mtime so repeat calls for an unchanged transcript are a
 * single fs.stat.
 */
async function usageForOne(filePath) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return null;
  const cached = usageCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.usage;
  }
  if (stat.size > MAX_USAGE_FILE_BYTES) {
    logs.writeLine({
      level: 'warn',
      scope: 'transcripts',
      message: 'usageForOne: transcript too large, skipping',
      meta: { filePath, size: stat.size },
    });
    return null;
  }
  const text = await fsp.readFile(filePath, 'utf8').catch(() => null);
  if (text === null) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = classifyLine(obj);
    if (!ev || ev.kind !== 'usage') continue;
    const u = ev.data || {};
    inputTokens += u.input_tokens ?? u.inputTokens ?? 0;
    outputTokens += u.output_tokens ?? u.outputTokens ?? 0;
  }
  const usage = { inputTokens, outputTokens };
  usageCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
  return usage;
}

/**
 * Batched token-usage lookup for the Epics workspace — one IPC call per
 * visible set of Epics rather than a per-row round trip. Returns a map keyed
 * by sessionId; a session with no transcript file yet (or one over the size
 * cap) maps to null so callers can omit it rather than showing "0".
 */
async function usageFor(cwd, sessionIds) {
  const out = {};
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      const filePath = transcriptPath(cwd, sessionId);
      out[sessionId] = await usageForOne(filePath);
    }),
  );
  return out;
}

function closeAll() {
  for (const sub of subs.values()) sub.watcher?.close().catch(() => {});
  subs.clear();
}

function registerTranscriptHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('transcript:subscribe', v(s.transcriptSubscribe, (payload) => subscribe(payload)));
  // transcript:unsubscribe is now an alias for release (view-switch, not close).
  ipcMain.handle('transcript:unsubscribe', v(s.transcriptTabId, ({ tabId }) => {
    release(tabId);
    return { ok: true };
  }));
  // transcript:close is the genuine close used when a tab is removed.
  ipcMain.handle('transcript:close', v(s.transcriptTabId, ({ tabId }) => {
    closeTab(tabId);
    return { ok: true };
  }));
  ipcMain.handle('transcript:buffer', v(s.transcriptTabId, ({ tabId }) => getBuffer(tabId)));
  ipcMain.handle('transcript:path', v(s.transcriptPath, ({ cwd, sessionUuid }) => transcriptPath(cwd, sessionUuid)));
  ipcMain.handle('transcript:usageFor', v(s.transcriptUsageFor, ({ cwd, sessionIds }) => usageFor(cwd, sessionIds)));
}

module.exports = {
  attachWindow,
  registerTranscriptHandlers,
  closeAll,
  release,
  closeTab,
  encodeCwd,
  transcriptPath,
  classifyLine,
  usageFor,
};
