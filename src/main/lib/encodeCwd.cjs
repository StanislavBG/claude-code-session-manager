/**
 * encodeCwd.cjs — canonical "cwd to directory-safe slug" encoder.
 *
 * Mirrors Claude Code's transcript directory naming convention: replace every
 * non-alphanumeric character with '-'. Used by:
 *   - transcripts.cjs to locate `~/.claude/projects/<encoded>/<sessionUuid>.jsonl`
 *   - memoryTool.cjs to derive the workspace label for memory storage
 *   - the renderer's Memory tab (purely advisory; main process is authoritative)
 *
 * Falls back to 'default' on null/blank input so callers always get a valid slug.
 */
'use strict';

function encodeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string' || !cwd.trim()) return 'default';
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

module.exports = { encodeCwd };
