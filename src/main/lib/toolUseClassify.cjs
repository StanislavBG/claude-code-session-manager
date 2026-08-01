'use strict';

// Same cap classifyTranscriptLine.cjs uses (MAX_RAW_STR) for raw tool_use
// content — reused here so a large Edit/Write payload can't bloat the
// in-memory ChatTurn / localStorage-persisted chat state.
const MAX_DIFF_STR = 4096;

function capStr(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_DIFF_STR ? `${s.slice(0, MAX_DIFF_STR)}…` : s;
}

/**
 * Pull a diff payload out of an Edit/Write tool_use block's `input`.
 * Returns undefined for any other tool (including malformed Edit/Write
 * blocks missing `file_path`).
 * @param {{name: string, input?: Record<string, unknown>}} block
 * @returns {{ filePath: string, oldText?: string, newText?: string } | undefined}
 */
function extractDiff(block) {
  const input = block?.input;
  if (!input || typeof input !== 'object' || typeof input.file_path !== 'string') return undefined;
  if (block.name === 'Edit') {
    return {
      filePath: input.file_path,
      oldText: capStr(input.old_string),
      newText: capStr(input.new_string),
    };
  }
  if (block.name === 'Write') {
    return {
      filePath: input.file_path,
      newText: capStr(input.content),
    };
  }
  return undefined;
}

/**
 * Classify a single stream-json tool_use block into a UI-facing kind.
 * O(1) — no loops, pure string/prefix checks.
 * @param {{name: string, input?: Record<string, unknown>}} block
 * @returns {{ kind: 'skill' | 'mcp' | 'tool', label: string, diff?: { filePath: string, oldText?: string, newText?: string } }}
 */
function classifyToolUse(block) {
  if (block.name === 'Skill') {
    return { kind: 'skill', label: block.input?.skill ?? 'skill' };
  }
  if (block.name.startsWith('mcp__')) {
    return { kind: 'mcp', label: block.name.replace(/^mcp__/, '') };
  }
  const diff = extractDiff(block);
  return diff ? { kind: 'tool', label: block.name, diff } : { kind: 'tool', label: block.name };
}

module.exports = { classifyToolUse, extractDiff, MAX_DIFF_STR };
