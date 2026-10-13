'use strict';

// Bounded-tail reader for Claude Code JSONL transcripts: the last N human-readable
// chat messages (user prompts + assistant text) without reading the whole file.
// Top-level (no domain fits: epic/ transcripts are path-only; util/ is domain-free).
// Transcripts reach hundreds of MB, so cost is O(maxBytes), never O(file).

const fsp = require('node:fs/promises');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_MAX_BYTES = 524288;
const MAX_TEXT_CHARS = 4000;

/** Join the plain-text parts of a message `content` (string or block array). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function truncate(text) {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS - 1) + '…' : text;
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

module.exports = { readRecentChatMessages };
