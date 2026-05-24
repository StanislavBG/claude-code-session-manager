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

function transcriptPath(cwd, sessionUuid) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionUuid}.jsonl`);
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
    return { kind: 'usage', data: obj.usage || msg.usage, raw: obj };
  }

  // Tool uses: scan content array for tool_use blocks.
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use') {
        if (block.name === 'TodoWrite') {
          return { kind: 'todo_write', data: block.input?.todos || block.input || [], raw: obj };
        }
        if (block.name === 'ExitPlanMode' || block.name === 'EnterPlanMode') {
          return { kind: 'plan', data: block.input, raw: obj };
        }
        if (block.name === 'Agent' || block.name === 'Task') {
          // Include block.id as toolUseId so the live store can match the
          // corresponding tool_result and update per-agent lastActivityAt.
          return { kind: 'agent_spawn', data: { ...block.input, toolUseId: block.id }, raw: obj };
        }
        return {
          kind: 'tool_use',
          data: { name: block.name, input: block.input, id: block.id },
          raw: obj,
        };
      }
      // tool_result carries the tool_use_id of the completed Task/Agent call.
      // The live store uses this to update the agent's lastActivityAt bookend.
      if (block?.type === 'tool_result' && block.tool_use_id) {
        return { kind: 'tool_result', data: { toolUseId: block.tool_use_id }, raw: obj };
      }
    }
  }

  return { kind: type || 'message', data: obj, raw: obj };
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

async function flush(sub, { emit = true } = {}) {
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

const MAX_TRANSCRIPT_SUBS = 20;

async function subscribe({ tabId, cwd, sessionUuid }) {
  if (subs.has(tabId)) return { ok: true, path: subs.get(tabId).filePath };
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
  };
  // If the file already exists, read current content as replay. Do not emit
  // during this initial drain — the renderer drains sub.buffer via
  // `transcript:buffer` after `transcript:subscribe` resolves. Emitting here
  // would race the renderer's onEvent listener registration and drop events.
  if (fs.existsSync(filePath)) {
    await flush(sub, { emit: false });
  }
  const watcher = chokidar.watch(filePath, {
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 20 },
  });
  watcher.on('add', () => flush(sub).catch(() => {}));
  watcher.on('change', () => flush(sub).catch(() => {}));
  watcher.on('error', (err) => logs.writeLine({ level: 'warn', scope: 'transcripts', message: 'chokidar watcher error', meta: { error: err?.message } }));
  sub.watcher = watcher;
  subs.set(tabId, sub);
  return { ok: true, path: filePath };
}

function unsubscribe(tabId) {
  const sub = subs.get(tabId);
  if (!sub) return;
  sub.watcher?.close().catch(() => {});
  subs.delete(tabId);
}

function getBuffer(tabId) {
  const sub = subs.get(tabId);
  return sub ? sub.buffer.slice() : [];
}

function closeAll() {
  for (const sub of subs.values()) sub.watcher?.close().catch(() => {});
  subs.clear();
}

function registerTranscriptHandlers() {
  const { schemas: s, validated: v } = require('./ipcSchemas.cjs');
  ipcMain.handle('transcript:subscribe', v(s.transcriptSubscribe, (payload) => subscribe(payload)));
  ipcMain.handle('transcript:unsubscribe', v(s.transcriptTabId, ({ tabId }) => {
    unsubscribe(tabId);
    return { ok: true };
  }));
  ipcMain.handle('transcript:buffer', v(s.transcriptTabId, ({ tabId }) => getBuffer(tabId)));
  ipcMain.handle('transcript:path', v(s.transcriptPath, ({ cwd, sessionUuid }) => transcriptPath(cwd, sessionUuid)));
}

module.exports = {
  attachWindow,
  registerTranscriptHandlers,
  closeAll,
  encodeCwd,
  transcriptPath,
};
