'use strict';

/**
 * personaLoadout.cjs — the four loadout states of an agent's `tools:` decision
 * and their one on-disk encoding, read the same way by Session Manager and
 * Claude Code's own subagent loader.
 *
 *   undecided  no `tools:` line (or an empty one). Runs as today (all tools);
 *              reports Undecided so the owner can decide.
 *   bare       `tools: none` — zero granted tools beyond the headless floor.
 *              The native loader sees one tool name that matches nothing.
 *   equipped   `tools: A, B, C` — exactly those tools.
 *   unbound    `tools: *` — every tool, an explicit decision.
 *
 * NOTE: the bare/unbound encodings are NOT probe-verified against the CLI
 * (no network in the authoring run); see the PRD report.
 */

const BARE_TOOL = 'none';
const UNBOUND_TOOL = '*';

/** @param {unknown} raw frontmatter `tools` (comma string or string list) */
function toolNames(raw) {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return items.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
}

/**
 * @param {{ tools?: unknown }|null|undefined} fm parsed frontmatter
 * @returns {'undecided'|'bare'|'equipped'|'unbound'}
 */
function loadoutState(fm) {
  const names = toolNames(fm ? fm.tools : undefined);
  if (names.length === 0) return 'undecided';
  if (names.includes(UNBOUND_TOOL)) return 'unbound';
  if (names.length === 1 && names[0].toLowerCase() === BARE_TOOL) return 'bare';
  return 'equipped';
}

/**
 * The `tools:` value to write, or null for no line (undecided, or equipped
 * with no tools).
 * @param {'undecided'|'bare'|'equipped'|'unbound'} state
 * @param {readonly string[]|null|undefined} tools
 * @returns {string|null}
 */
function encodeLoadout(state, tools) {
  if (state === 'bare') return BARE_TOOL;
  if (state === 'unbound') return UNBOUND_TOOL;
  if (state === 'equipped') {
    const names = toolNames(tools).filter((t) => t !== UNBOUND_TOOL && t.toLowerCase() !== BARE_TOOL);
    return names.length ? names.join(', ') : null;
  }
  return null;
}

module.exports = { BARE_TOOL, UNBOUND_TOOL, loadoutState, encodeLoadout };
