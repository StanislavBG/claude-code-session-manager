'use strict';

/**
 * personaLoadout.cjs — the four loadout states of an agent's `tools:` decision
 * and their one on-disk encoding, read the same way by Session Manager and
 * Claude Code's own subagent loader.
 *
 * Verified offline against the CLI 2.1.330 binary (agent parse: `Ygt(r.tools)`
 * over `Cdn`): key absent = all tools; `tools:` (null), `""` or `[]` = ZERO
 * tools; any `*` = all tools.
 *
 *   undecided  `tools` key absent. Runs as today (all tools); reports Undecided.
 *   bare       `tools: []` — zero granted tools beyond the headless floor.
 *              An empty `tools:` line and `""` mean the same to the loader.
 *   equipped   `tools: A, B, C` — exactly those tools.
 *   unbound    `tools: *` — every tool, an explicit decision.
 *
 * SM's frontmatter parser has no flow arrays: `tools: []` arrives as "[]".
 */

const BARE_ENCODING = '[]';
const UNBOUND_TOOL = '*';

/** @param {unknown} raw frontmatter `tools` (comma string or string list) */
function toolNames(raw) {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return items.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean).filter((t) => t !== BARE_ENCODING);
}

/**
 * @param {{ tools?: unknown }|null|undefined} fm parsed frontmatter
 * @returns {'undecided'|'bare'|'equipped'|'unbound'}
 */
function loadoutState(fm) {
  if (!fm || fm.tools === undefined || !('tools' in fm)) return 'undecided';
  const names = toolNames(fm.tools);
  if (names.includes(UNBOUND_TOOL)) return 'unbound';
  return names.length === 0 ? 'bare' : 'equipped';
}

/**
 * The `tools:` value to write, or null for no line (undecided, or equipped
 * with no tools).
 * @param {'undecided'|'bare'|'equipped'|'unbound'} state
 * @param {readonly string[]|null|undefined} tools
 * @returns {string|null}
 */
function encodeLoadout(state, tools) {
  if (state === 'bare') return BARE_ENCODING;
  if (state === 'unbound') return UNBOUND_TOOL;
  if (state === 'equipped') {
    const names = toolNames(tools).filter((t) => t !== UNBOUND_TOOL);
    return names.length ? names.join(', ') : null;
  }
  return null;
}

module.exports = { BARE_ENCODING, UNBOUND_TOOL, loadoutState, encodeLoadout };
