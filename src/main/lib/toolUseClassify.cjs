'use strict';

/**
 * Classify a single stream-json tool_use block into a UI-facing kind.
 * O(1) — no loops, pure string/prefix checks.
 * @param {{name: string, input?: Record<string, unknown>}} block
 * @returns {{ kind: 'skill' | 'mcp' | 'tool', label: string }}
 */
function classifyToolUse(block) {
  if (block.name === 'Skill') {
    return { kind: 'skill', label: block.input?.skill ?? 'skill' };
  }
  if (block.name.startsWith('mcp__')) {
    return { kind: 'mcp', label: block.name.replace(/^mcp__/, '') };
  }
  return { kind: 'tool', label: block.name };
}

module.exports = { classifyToolUse };
