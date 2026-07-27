'use strict';

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

module.exports = { MAX_RAW_STR, EXEMPT_TYPES, trimContentArray, makeRaw, classifyLine };
