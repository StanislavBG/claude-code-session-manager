'use strict';

// Bounded-tail reader for Claude Code JSONL transcripts: the last N human-readable
// chat messages (user prompts + assistant text) without reading the whole file.
// Also builds the phone's conversation page (exchanges + live tail) in pure code.
// Top-level (no domain fits: epic/ transcripts are path-only; util/ is domain-free).
// Transcripts reach hundreds of MB, so cost is O(maxBytes), never O(file).

const fsp = require('node:fs/promises');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BYTES = 524288;
const MAX_TEXT_CHARS = 4000;
const MAX_PROMPT_CHARS = 2000;
const MAX_RESULT_CHARS = 16000;
const MAX_LIVE_MESSAGES = 20;
const MAX_PAGE_TEXT_BYTES = 100000; // relay closes any message over 256 KB

/** Join the plain-text parts of a message `content` (string or block array). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function cap(text, max) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function truncate(text) {
  return cap(text, MAX_TEXT_CHARS);
}

/** Parse one JSONL line into a chat message, or null when it is not one. */
function toChatMessage(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  if (entry.isMeta || entry.isSidechain) return null;
  const role = entry.type;
  if (role !== 'user' && role !== 'assistant') return null;
  const text = textOf(entry.message?.content).trim();
  if (!text) return null;
  return {
    role,
    text: truncate(text),
    ts: typeof entry.timestamp === 'string' ? entry.timestamp : null,
    uuid: typeof entry.uuid === 'string' ? entry.uuid : null,
  };
}

/**
 * @param {string} filePath
 * @param {{ limit?: number, maxBytes?: number }} [opts]
 * @returns {Promise<Array<{ role: 'user'|'assistant', text: string, ts: string|null, uuid: string|null }>>}
 *   oldest first; [] on any read failure.
 */
async function readRecentChatMessages(filePath, { limit = DEFAULT_LIMIT, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof filePath !== 'string' || !filePath) return [];
  const n = Math.floor(Number(limit));
  const lim = Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : DEFAULT_LIMIT;
  const cap = Math.max(1, Math.floor(Number(maxBytes)) || DEFAULT_MAX_BYTES);
  let fd;
  try {
    fd = await fsp.open(filePath, 'r');
    const { size } = await fd.stat();
    if (size === 0) return [];
    const start = Math.max(0, size - cap);
    // From mid-file, read one extra leading byte so the first split part is
    // always a fragment (empty when start sits on a line boundary) — drop it.
    const from = start > 0 ? start - 1 : 0;
    const len = size - from;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fd.read(buf, 0, len, from);
    const parts = buf.toString('utf8', 0, bytesRead).split('\n');
    if (start > 0) parts.shift();
    const out = [];
    for (const line of parts) {
      if (!line) continue;
      const msg = toChatMessage(line);
      if (msg) out.push(msg);
    }
    return out.slice(-lim);
  } catch {
    return [];
  } finally {
    await fd?.close().catch(() => {});
  }
}

/**
 * Pure: build one phone-ready conversation page from exchanges (NEWEST-FIRST,
 * callers fetch `limit + 1` so `hasMore` is derivable) plus the live transcript tail.
 * @param {{ exchanges?: any[], tail?: any[], limit?: number, before?: number }} [opts]
 * @returns {{ messages: Array<{ role: string, text: string, ts: string|null, uuid: string|null, live?: true }>, hasMore: boolean, nextBefore: number|null }}
 *   messages oldest-first: history, then live.
 */
function buildRemoteConversation({ exchanges = [], tail = [], limit = 10, before = 0 } = {}) {
  const n = Math.floor(Number(limit));
  const lim = Number.isFinite(n) && n >= 1 ? n : 10;
  const b = Math.max(0, Math.floor(Number(before)) || 0);
  const valid = (Array.isArray(exchanges) ? exchanges : []).filter((e) => e && typeof e === 'object' && typeof e.ts === 'string');
  const candidates = valid.slice(0, lim);
  let hasMore = valid.length > lim;
  let budget = MAX_PAGE_TEXT_BYTES;
  const size = (text) => Buffer.byteLength(text, 'utf8');

  // Live tail (first page only): newest-first until the budget is hit.
  const live = [];
  if (b === 0 && Array.isArray(tail)) {
    const newest = valid.reduce((m, e) => Math.max(m, Date.parse(e.ts) || 0), 0);
    const fresh = tail.filter((m) => {
      if (!m || typeof m !== 'object' || typeof m.text !== 'string') return false;
      if (!valid.length) return true;
      const t = typeof m.ts === 'string' ? Date.parse(m.ts) : NaN;
      return Number.isFinite(t) && t > newest;
    });
    for (const m of fresh.slice(-MAX_LIVE_MESSAGES).reverse()) {
      const bytes = size(m.text);
      if (bytes > budget) break;
      budget -= bytes;
      live.push({ role: m.role, text: m.text, ts: m.ts ?? null, uuid: m.uuid ?? null, live: true });
    }
    live.reverse();
  }

  // History: whole exchanges newest-first, oldest dropped when over budget.
  const history = [];
  let returned = 0;
  for (const e of candidates) {
    const pair = [];
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : '';
    const result = typeof e.result === 'string' ? e.result.trim() : '';
    if (prompt) pair.push({ role: 'user', text: cap(prompt, MAX_PROMPT_CHARS), ts: e.ts, uuid: `ex:${e.ts}:u` });
    if (result) pair.push({ role: 'assistant', text: cap(result, MAX_RESULT_CHARS), ts: e.ts, uuid: `ex:${e.ts}:a` });
    const bytes = pair.reduce((s, m) => s + size(m.text), 0);
    if (bytes > budget) {
      hasMore = true;
      break;
    }
    budget -= bytes;
    history.unshift(...pair);
    returned++;
  }

  return { messages: [...history, ...live], hasMore, nextBefore: hasMore ? b + returned : null };
}

module.exports = { readRecentChatMessages, buildRemoteConversation };
