'use strict';

/**
 * projectBriefCore.cjs — pure logic for the per-project "Brief" backend
 * (PRD 837). No fs/spawn/Electron access here — projectBrief.cjs gathers raw
 * stat/count inputs and hands them to these functions so the decision logic
 * (drift, prompt shape, output validation, pin enforcement) is unit-testable
 * with plain-object inputs.
 *
 * brief.json shape (see design-mocks/home/DESIGN_SPEC.md "Persistence"):
 *   { version, synthesizedAt, editedAt, model, purpose, what[], areas[],
 *     scope[], conventions[], pins{what,conventions}, pinned{what,conventions} }
 *
 * The file is not write-once: `computeUpdate` is the hand-edit path (the
 * "maintain" half of generate-and-maintain), so the brief can be corrected
 * without paying for a full re-synthesis.
 */

const BRIEF_VERSION = 1;
const PINNABLE_BLOCKS = ['what', 'conventions'];
/** Fields a caller may hand-edit through `computeUpdate`. Editing a PINNABLE
 *  block also auto-pins it, so the next refresh cannot silently undo the edit;
 *  the derived blocks (areas/scope) are re-synthesized on every refresh by
 *  design, so edits to them are a stopgap, not a source of truth. */
const EDITABLE_FIELDS = ['purpose', 'what', 'areas', 'scope', 'conventions'];

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
 *  the pin-enforced content. `nowIso` is passed in — never computed here.
 *  `priorEditedAt` carries forward so a refresh doesn't erase the record that
 *  the (pinned, therefore preserved) blocks were hand-edited. */
function buildPersistedBrief({ rawBrief, priorPins, priorPinned, model, nowIso, priorEditedAt = null }) {
  const enforced = applyPinEnforcement(rawBrief, priorPins, priorPinned);
  return {
    version: BRIEF_VERSION,
    synthesizedAt: nowIso,
    editedAt: priorEditedAt || null,
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

/** Per-field shape guard for a hand-edit patch. Mirrors validateBriefShape's
 *  strictness so an edit can never write a brief the renderer can't render. */
function validateUpdateField(field, value) {
  if (field === 'purpose') {
    if (typeof value !== 'string' || !value.trim()) return 'purpose must be a non-empty string';
    return null;
  }
  if (!Array.isArray(value)) return `${field} must be an array`;
  if (field === 'what' || field === 'conventions') {
    if (value.some((v) => typeof v !== 'string')) return `${field} must be an array of strings`;
    return null;
  }
  if (value.some((v) => !v || typeof v !== 'object' || Array.isArray(v))) return `${field} must be an array of objects`;
  return null;
}

/**
 * Pure hand-edit transform. Given the current brief (or null), a patch of
 * editable fields, and `nowIso`, returns the next brief with the patch applied
 * and `editedAt` stamped. Any edited PINNABLE block is auto-pinned and its
 * frozen copy set to the new content, so the next refresh preserves the edit
 * instead of overwriting it. Returns {ok:false, error} on a missing brief,
 * an unknown/empty patch, or a field whose shape would break the renderer.
 *
 * Complexity: O(n) in the patched arrays' lengths.
 */
function computeUpdate(currentBrief, patch, nowIso) {
  if (!currentBrief) return { ok: false, error: 'no brief to edit yet — generate one first' };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch must be an object' };

  const fields = Object.keys(patch);
  if (fields.length === 0) return { ok: false, error: 'patch is empty' };
  const unknown = fields.filter((f) => !EDITABLE_FIELDS.includes(f));
  if (unknown.length) return { ok: false, error: `not editable: ${unknown.join(', ')}` };
  for (const f of fields) {
    const err = validateUpdateField(f, patch[f]);
    if (err) return { ok: false, error: err };
  }

  const next = { ...currentBrief, ...patch, editedAt: nowIso };
  next.pins = { what: false, conventions: false, ...(currentBrief.pins || {}) };
  next.pinned = { what: null, conventions: null, ...(currentBrief.pinned || {}) };
  for (const block of PINNABLE_BLOCKS) {
    if (fields.includes(block)) {
      next.pins[block] = true;
      next.pinned[block] = patch[block];
    }
  }
  return { ok: true, brief: next };
}

module.exports = {
  BRIEF_VERSION,
  PINNABLE_BLOCKS,
  EDITABLE_FIELDS,
  computeDrift,
  buildSources,
  buildSynthesisPrompt,
  validateBriefShape,
  applyPinEnforcement,
  buildPersistedBrief,
  computeSetPin,
  validateUpdateField,
  computeUpdate,
};
