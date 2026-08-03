'use strict';

// Bound on any single string field kept inline in the in-memory `raw`
// projection stored per event (events are ring-buffered up to 500 deep,
// see transcripts.cjs's sub.buffer). Anything longer is truncated here —
// the full untruncated line is still recoverable via the event's `ref`
// (byte offset/length into the transcript file on disk, see makeEvent).
const MAX_RAW_STR = 4096;

// Bound on the short human-scannable preview attached to every event.
// Deliberately much smaller than MAX_RAW_STR — previewText is for a
// glance, not a document; the full payload is always one disk read away
// via `ref`.
const PREVIEW_CHARS = 280;

// Historically tool_use/tool_result blocks were exempted from the
// MAX_RAW_STR cap so orchestrator.ts/race.ts could structurally re-parse
// them without a truncated mid-token "…". Both files were deleted
// 2026-07-30 (commit e3848c3, "delete Subagents-only dead code") along
// with the rest of the Subagents tab, and no current consumer needs an
// untruncated tool_result/tool_use block in the in-memory `raw`
// projection — holding one verbatim (e.g. a large Read tool_result) in a
// 500-entry ring buffer was a real memory-cliff incident. Every block
// type is now trimmed the same way; this stays exported (empty) in case
// a future structural consumer needs to opt a block type back out.
const EXEMPT_TYPES = new Set();

/**
 * Cap string fields in a content block array so arbitrary tool output
 * doesn't bloat the ring buffer. Blocks whose type is in EXEMPT_TYPES are
 * passed through intact (currently no type is exempt — see comment above).
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

/**
 * Build the raw projection carried on every event. Preserves every
 * top-level field on the line (attribution*, effort, gitBranch,
 * isSidechain, isMeta, requestId, isApiErrorMessage,
 * interruptedByShutdown, permissionMode, promptSource, toolUseResult,
 * etc.) — not just message.content — so the renderer can surface all of
 * it, however trivial or redundant. message.content is still run through
 * trimContentArray to bound size in the ring buffer.
 */
function makeRaw(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const raw = {};
  for (const key of Object.keys(obj)) {
    if (key === 'message') continue;
    raw[key] = obj[key];
  }
  if (obj.message && typeof obj.message === 'object') {
    raw.message = { ...obj.message, content: trimContentArray(obj.message.content) };
  }
  return raw;
}

/** Bounded, human-scannable preview of an event's data — never the source of truth. */
function buildPreviewText(data) {
  let s;
  if (typeof data === 'string') {
    s = data;
  } else {
    try {
      s = JSON.stringify(data);
    } catch {
      s = String(data);
    }
  }
  if (!s) return '';
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + '…' : s;
}

/**
 * Build one event. `ref` (optional) is `{ filePath, byteOffset, byteLength }`
 * pointing at the exact bytes of the source line on disk, so the full,
 * untruncated line can be re-read on demand instead of being held in
 * memory. classifyLine stays a pure function of (obj, ref) — callers that
 * don't have file context (e.g. unit tests) may omit ref.
 */
function makeEvent(kind, data, obj, ref) {
  return { kind, data, raw: makeRaw(obj), previewText: buildPreviewText(data), ref: ref || null };
}

/**
 * Classify one content block and push its event(s) onto `events`. Known
 * tool_use names get a specific kind (todo_write/plan/agent_spawn/tool_use);
 * tool_result blocks get 'tool_result'; text blocks inherit the message's
 * own type (assistant/user/…) so existing type-based consumers keep
 * working. Any other block type — including ones Anthropic hasn't shipped
 * yet — is surfaced under its own `content_<type>` kind rather than
 * silently dropped, so new block kinds stay visible instead of vanishing.
 */
function classifyBlock(block, obj, ref, type, events) {
  if (!block || typeof block !== 'object') return;
  if (block.type === 'tool_use') {
    if (block.name === 'TodoWrite') {
      events.push(makeEvent('todo_write', block.input?.todos || block.input || [], obj, ref));
    } else if (block.name === 'ExitPlanMode' || block.name === 'EnterPlanMode') {
      events.push(makeEvent('plan', block.input, obj, ref));
    } else if (block.name === 'Agent' || block.name === 'Task') {
      // Include block.id as toolUseId so the live store can match the
      // corresponding tool_result and update per-agent lastActivityAt.
      events.push(makeEvent('agent_spawn', { ...block.input, toolUseId: block.id }, obj, ref));
    } else {
      events.push(makeEvent('tool_use', { name: block.name, input: block.input, id: block.id }, obj, ref));
    }
    return;
  }
  // tool_result carries the tool_use_id of the completed Task/Agent call.
  // The live store uses this to update the agent's lastActivityAt bookend.
  if (block.type === 'tool_result' && block.tool_use_id) {
    events.push(makeEvent('tool_result', { toolUseId: block.tool_use_id }, obj, ref));
    return;
  }
  if (block.type === 'text' && typeof block.text === 'string') {
    events.push(makeEvent(type || 'text', block.text, obj, ref));
    return;
  }
  events.push(makeEvent(block.type ? `content_${block.type}` : 'content_block', block, obj, ref));
}

/**
 * Parse one JSONL line defensively. Real schema drifts, so we pass
 * through anything that parses and tag a coarse `kind` per event.
 *
 * Returns an ARRAY of events (empty array for an unclassifiable line) —
 * a single line can legitimately carry more than one event: a usage
 * rollup alongside real content, or an assistant turn with text plus
 * several tool calls in the same content array. No caller may assume a
 * line produces at most one event.
 */
function classifyLine(obj, ref) {
  if (!obj || typeof obj !== 'object') return [];
  const events = [];
  const type = obj.type || obj.event || obj.role;
  const msg = obj.message || obj;
  const content = msg?.content;
  const usage = obj.usage || msg?.usage;

  // Usage rollups arrive as summary events — emitted alongside whatever
  // content the same line carries, never instead of it.
  if (usage) {
    events.push(makeEvent('usage', usage, obj, ref));
  }

  if (Array.isArray(content) && content.length > 0) {
    for (const block of content) classifyBlock(block, obj, ref, type, events);
  } else if (!usage) {
    events.push(makeEvent(type || 'message', obj, obj, ref));
  }

  return events;
}

module.exports = { MAX_RAW_STR, PREVIEW_CHARS, EXEMPT_TYPES, trimContentArray, makeRaw, buildPreviewText, classifyLine };
