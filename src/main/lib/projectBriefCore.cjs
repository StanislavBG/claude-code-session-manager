'use strict';

/**
 * projectBriefCore.cjs — pure logic for the per-project "Brief" backend
 * (PRD 837). No fs/spawn/Electron access here — projectBrief.cjs gathers raw
 * stat/count inputs and hands them to these functions so the decision logic
 * (drift, prompt shape, output validation, pin enforcement) is unit-testable
 * with plain-object inputs.
 *
 * brief.json shape (see design-mocks/home/DESIGN_SPEC.md "Persistence"):
 *   { version, synthesizedAt, model, purpose, what[], areas[], scope[],
 *     conventions[], pins{what,conventions}, pinned{what,conventions} }
 */

const BRIEF_VERSION = 1;
const PINNABLE_BLOCKS = ['what', 'conventions'];

/** true when a source's mtime is strictly newer than the brief's synthesizedAt. */
function computeDrift(mtimeMs, synthesizedAtMs) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return false;
  if (typeof synthesizedAtMs !== 'number' || !Number.isFinite(synthesizedAtMs)) return false;
  return mtimeMs > synthesizedAtMs;
}

/**
 * Assemble the `sources` list from cheaply-gathered raw data. Each of
 * `claudeMd`/`epics`/`sessions`/`git` is either null (source omitted — e.g.
 * missing CLAUDE.md, or `git` for a non-repo cwd) or `{ detail, mtimeMs }`.
 * `synthesizedAt` is the brief's ISO timestamp (or null if no brief yet).
 *
 * Complexity: O(1) — fixed four-source list.
 */
function buildSources({ synthesizedAt, claudeMd, epics, sessions, git }) {
  const synthMs = typeof synthesizedAt === 'string' ? Date.parse(synthesizedAt) : null;
  const mk = (label, data) => {
    if (!data) return null;
    return {
      label,
      detail: data.detail,
      mtimeMs: typeof data.mtimeMs === 'number' ? data.mtimeMs : null,
      drift: computeDrift(data.mtimeMs, synthMs),
    };
  };
  return [
    mk('CLAUDE.md', claudeMd),
    mk('Epics', epics),
    mk('Sessions', sessions),
    mk('Git', git),
  ].filter(Boolean);
}

/**
 * Build the synthesis prompt fed to `claude -p`. Pure string assembly —
 * takes already-gathered text/lists, never touches fs/spawn.
 *
 * `pinnedBlocks`: { what: array|null, conventions: array|null } — frozen
 * content for pinned blocks, included verbatim with an instruction to
 * return them unchanged (enforcement also happens in code — see
 * applyPinEnforcement — this is belt-and-suspenders on the prompt side).
 */
function buildSynthesisPrompt({ claudeMdText, epics, gitLogLines, srcTree, pinnedBlocks }) {
  const epicsSection = (epics && epics.length)
    ? epics.map((e) => `- [${e.status}${e.tag ? `/${e.tag}` : ''}] ${e.goalText}`).join('\n')
    : '(no Epics recorded yet)';
  const gitSection = (gitLogLines && gitLogLines.length) ? gitLogLines.join('\n') : '(no git history)';
  const treeSection = srcTree || '(no src/ directory)';
  const pins = pinnedBlocks || {};
  const pinnedSection = PINNABLE_BLOCKS
    .filter((b) => pins[b] != null)
    .map((b) => `PINNED BLOCK "${b}" — return this EXACT value verbatim for "${b}" in your output, do not rewrite it:\n${JSON.stringify(pins[b])}`)
    .join('\n\n');

  return `You are synthesizing a project "Brief" — a concise, provenance-carrying summary of a software project for a developer returning to it after time away.

Inputs:

<claude_md>
${claudeMdText || '(no CLAUDE.md found)'}
</claude_md>

<epics>
${epicsSection}
</epics>

<git_log>
${gitSection}
</git_log>

<src_tree>
${treeSection}
</src_tree>

${pinnedSection ? `${pinnedSection}\n\n` : ''}Output ONLY valid JSON (no prose, no code fences) matching exactly this shape:
{
  "purpose": "one-sentence project purpose",
  "what": ["paragraph using **bold** and \`code\` mini-markdown", "..."],
  "areas": [{"name": "", "files": 0, "note": "", "epic": null, "heat": 0.0}],
  "scope": [{"when": "", "kind": "added|narrowed|decided", "text": "", "src": ""}],
  "conventions": ["..."]
}`;
}

/** Shallow shape check on the model's extracted JSON — not a full schema, just
 *  enough to reject a malformed/empty response before it's persisted. */
function validateBriefShape(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not an object' };
  if (typeof obj.purpose !== 'string' || !obj.purpose.trim()) return { ok: false, error: 'missing purpose' };
  if (!Array.isArray(obj.what)) return { ok: false, error: 'missing what[]' };
  if (!Array.isArray(obj.areas)) return { ok: false, error: 'missing areas[]' };
  if (!Array.isArray(obj.scope)) return { ok: false, error: 'missing scope[]' };
  if (!Array.isArray(obj.conventions)) return { ok: false, error: 'missing conventions[]' };
  return { ok: true, error: null };
}

/**
 * Merge a freshly-synthesized brief with the prior pin state. Pinned blocks
 * are overwritten with the FROZEN stored copy (code-enforced, not just
 * prompt-requested) before persisting; pins/pinned themselves carry forward
 * unchanged (only setPin mutates them).
 */
function applyPinEnforcement(rawBrief, priorPins, priorPinned) {
  const pins = { what: false, conventions: false, ...(priorPins || {}) };
  const pinned = { what: null, conventions: null, ...(priorPinned || {}) };
  const merged = { ...rawBrief };
  for (const block of PINNABLE_BLOCKS) {
    if (pins[block] && pinned[block] != null) {
      merged[block] = pinned[block];
    }
  }
  return { ...merged, pins, pinned };
}

/** Full persisted-shape builder: stamps version/synthesizedAt/model on top of
 *  the pin-enforced content. `nowIso` is passed in — never computed here. */
function buildPersistedBrief({ rawBrief, priorPins, priorPinned, model, nowIso }) {
  const enforced = applyPinEnforcement(rawBrief, priorPins, priorPinned);
  return {
    version: BRIEF_VERSION,
    synthesizedAt: nowIso,
    model,
    purpose: enforced.purpose,
    what: enforced.what,
    areas: enforced.areas,
    scope: enforced.scope,
    conventions: enforced.conventions,
    pins: enforced.pins,
    pinned: enforced.pinned,
  };
}

/**
 * Pure setPin transform: given the current brief (or null), a block name,
 * and the desired pinned boolean, returns the next brief object with
 * pins[block] updated and pinned[block] frozen (current block content) or
 * cleared (null). Returns {ok:false, error} when there's no brief to pin.
 */
function computeSetPin(currentBrief, block, pinned) {
  if (!PINNABLE_BLOCKS.includes(block)) return { ok: false, error: `block must be one of ${PINNABLE_BLOCKS.join(', ')}` };
  if (!currentBrief) return { ok: false, error: 'no brief to pin yet — refresh first' };
  const nextPins = { what: false, conventions: false, ...(currentBrief.pins || {}), [block]: pinned };
  const nextPinned = { what: null, conventions: null, ...(currentBrief.pinned || {}) };
  nextPinned[block] = pinned ? (currentBrief[block] ?? null) : null;
  return { ok: true, brief: { ...currentBrief, pins: nextPins, pinned: nextPinned } };
}

module.exports = {
  BRIEF_VERSION,
  PINNABLE_BLOCKS,
  computeDrift,
  buildSources,
  buildSynthesisPrompt,
  validateBriefShape,
  applyPinEnforcement,
  buildPersistedBrief,
  computeSetPin,
};
