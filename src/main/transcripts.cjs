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
const usageMatrix = require('./usageMatrix.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

let window = null;

/** Map<tabId, Subscription> */
const subs = new Map();

function attachWindow(w) {
  window = w;
}

const { encodeCwd } = require('./lib/encodeCwd.cjs');

function transcriptPath(cwd, sessionUuid) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionUuid}.jsonl`);
}

const MAX_RAW_STR = 4096;

// Block types whose text/content fields are parsed structurally by
// orchestrator.ts / race.ts — truncating them produces mid-token "…" and
// unparseable JSON, so they are exempt from the size cap.
const EXEMPT_TYPES = new Set(['tool_result', 'tool_use']);

/**
 * Cap string fields in a content block array so arbitrary tool output doesn't
 * bloat the ring buffer. Blocks whose type is in EXEMPT_TYPES are passed
 * through intact so that structured result payloads survive to the digest
 * parsers in race.ts / orchestrator.ts.
 */
function trimContentArray(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (EXEMPT_TYPES.has(block.type)) return block;
    const b = { ...block };
    if (typeof b.text === 'string' && b.text.length > MAX_RAW_STR) {
      b.text = b.text.slice(0, MAX_RAW_STR) + '…';
    }
    if (typeof b.content === 'string' && b.content.length > MAX_RAW_STR) {
      b.content = b.content.slice(0, MAX_RAW_STR) + '…';
    }
    if (Array.isArray(b.content)) {
      b.content = trimContentArray(b.content);
    }
    return b;
  });
}

/** Build the slim raw projection used by race.ts and orchestrator.ts. */
function makeRaw(obj) {
  const msgContent = obj?.message?.content;
  return { message: { content: trimContentArray(msgContent) } };
}

/**
 * Parse one JSONL line defensively. Real schema drifts, so we pass through
 * anything that parses and tag a coarse `kind`.
 */
function classifyLine(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // Many shapes exist — try several common fields.
  const type = obj.type || obj.event || obj.role;
  const msg = obj.message || obj;
  const content = msg?.content;

  // Usage rollups arrive as summary events.
  if (obj.usage || msg?.usage) {
    return { kind: 'usage', data: obj.usage || msg.usage, raw: makeRaw(obj) };
  }

  // Tool uses: scan content array for tool_use blocks.
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use') {
        if (block.name === 'TodoWrite') {
          return { kind: 'todo_write', data: block.input?.todos || block.input || [], raw: makeRaw(obj) };
        }
        if (block.name === 'ExitPlanMode' || block.name === 'EnterPlanMode') {
          return { kind: 'plan', data: block.input, raw: makeRaw(obj) };
        }
        if (block.name === 'Agent' || block.name === 'Task') {
          // Include block.id as toolUseId so the live store can match the
          // corresponding tool_result and update per-agent lastActivityAt.
          return { kind: 'agent_spawn', data: { ...block.input, toolUseId: block.id }, raw: makeRaw(obj) };
        }
        return {
          kind: 'tool_use',
          data: { name: block.name, input: block.input, id: block.id },
          raw: makeRaw(obj),
        };
      }
      // tool_result carries the tool_use_id of the completed Task/Agent call.
      // The live store uses this to update the agent's lastActivityAt bookend.
      if (block?.type === 'tool_result' && block.tool_use_id) {
        return { kind: 'tool_result', data: { toolUseId: block.tool_use_id }, raw: makeRaw(obj) };
      }
    }
  }

  return { kind: type || 'message', data: obj, raw: makeRaw(obj) };
}

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
  const fd = await fsp.open(sub.filePath, 'r');
  try {
    const length = stat.size - sub.offset;
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, sub.offset);
    const text = sub.pending + buf.toString('utf8');
    const parts = text.split('\n');
    sub.pending = parts.pop() ?? '';
    sub.offset = stat.size;
    sub.inode = stat.ino;
    return parts.filter(Boolean);
  } finally {
    await fd.close();
  }
}

async function doFlush(sub, { emit = true, replay = false } = {}) {
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
    // Feed the AgOps aggregator on every event — both replay and live, so
    // freshly-attached tabs land with full history reflected in the matrix.
    usageMatrix.recordEvent({
      tabId: sub.tabId,
      cwd: sub.cwd,
      sessionUuid: sub.sessionUuid,
      ev,
      replay,
    });
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
  usageMatrix.removeTab(tabId);
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
  // replay:true prevents historical usage events from entering the 5-min window.
  if (fs.existsSync(filePath)) {
    await doFlush(sub, { emit: false, replay: true });
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

function closeAll() {
  for (const sub of subs.values()) sub.watcher?.close().catch(() => {});
  subs.clear();
  usageMatrix.closeAll();
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
};
