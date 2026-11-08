'use strict';

/**
 * macroJobDispatch.cjs — turn a built-in macro press into ONE artifact-only
 * scheduler PRD inside an existing Epic, so the build runs headless as the
 * macro's persona under the scheduler's budget instead of a chat turn.
 * Never mints an Epic (single-creator law): the caller supplies epicId.
 *
 * Plain Node, no Electron imports; all I/O is injected.
 */

const path = require('node:path');
const { BUILTIN_MACROS } = require('./builtinMacros.cjs');
const { kebabCase } = require('../util/kebabCase.cjs');

const ACTIVE = new Set(['pending', 'held', 'running']);
const RETRYABLE = new Set(['needs_review', 'failed']);

function buildGate(absPath, nowMs) {
  // No shell: everything with shell characters sits inside single quotes, so
  // the script itself uses double quotes only (JSON.stringify).
  const script = `const s=require("fs").statSync(${JSON.stringify(absPath)});process.exit(s.size>0&&s.mtimeMs>${nowMs}?0:1)`;
  return `timeout 60 node -e '${script}'`;
}

const PAGE_IDS = { 'how it works': 'how-it-works', faq: 'faq', overview: 'overview' };
// Same rule as ENTRY_ID_RE in ipcSchemas.cjs. The id becomes a path segment in
// artifactPaths, so an id taken from free text must pass it first.
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Reserved for the Competitor matrix snapshot; projectHomeAdminRoutes.cjs
// buildPage refuses it with the same constant. A builder page gets this instead.
const MATRIX_PAGE_ID = 'competitive-matrix';
const unreserve = (id) => (id === MATRIX_PAGE_ID ? `${MATRIX_PAGE_ID}-page` : id);

// Entry id: a valid 'Replace entry: <id>' line in the extra instructions
// (Regenerate) rebuilds that entry in place, for either kind; an invalid one
// is ignored. Otherwise videos get a fresh id per press and knowledge pages
// are named by a 'Page: <name>' line (default 'overview').
function entryIdFor(kind, extra, t) {
  return kind === 'video' ? rawEntryIdFor(kind, extra, t) : unreserve(rawEntryIdFor(kind, extra, t));
}

function rawEntryIdFor(kind, extra, t) {
  const replace = /^\s*Replace entry:\s*(\S+)\s*$/im.exec(extra || '');
  if (replace && ENTRY_ID_RE.test(replace[1])) return replace[1];
  if (kind === 'video') return `vid-${t.toString(36)}${Math.random().toString(36).slice(2, 5).padEnd(3, '0')}`;
  const m = /^\s*Page:\s*(.+?)\s*$/im.exec(extra || '');
  if (!m) return 'overview';
  const name = m[1];
  const known = PAGE_IDS[name.toLowerCase()];
  if (known) return known;
  const custom = /^custom topic:\s*(.+)$/i.exec(name);
  return kebabCase(custom ? custom[1] : name, { maxLen: 40, fallback: 'overview' });
}

async function dispatchMacroJob(
  { cwd, macroId, epicId, extraInstructions } = {},
  { createPrd, listRows, archivePrd, builtins = BUILTIN_MACROS, now = Date.now } = {},
) {
  const macro = (builtins || []).find((m) => m && m.id === macroId);
  if (!macro || !macro.job) return { ok: false, error: `macro ${macroId} has no background job declaration` };
  if (typeof epicId !== 'string' || !epicId.trim()) return { ok: false, error: 'epicId is required — a background build joins an existing Epic' };
  if (typeof cwd !== 'string' || !cwd) return { ok: false, error: 'cwd is required' };
  if (typeof createPrd !== 'function') return { ok: false, error: 'createPrd is not available' };

  const t = now();
  const extra = typeof extraInstructions === 'string' ? extraInstructions.trim() : '';
  const entryKind = macro.job.entryKind;
  const entryId = entryKind ? entryIdFor(entryKind, extra, t) : null;
  const artifactPaths = macro.job.artifactPaths.map((p) => (entryId ? p.split('{id}').join(entryId) : p));
  const absPaths = artifactPaths.map((p) => path.join(cwd, p));
  for (const s of [cwd, ...absPaths]) {
    if (s.includes("'") || /[\r\n]/.test(s)) return { ok: false, error: "cwd or artifact path contains a character the gate cannot quote (single quote or newline)" };
  }

  let rows = [];
  try {
    rows = (typeof listRows === 'function' ? await listRows({ cwd }) : []) || [];
  } catch (e) {
    return { ok: false, error: `could not read queue: ${e?.message ?? e}` };
  }
  const mine = rows.filter((r) => r && r.macroId === macroId && (!r.cwd || r.cwd === cwd));
  const active = mine.find((r) => ACTIVE.has(r.status));
  if (active) return { ok: false, error: `${macro.label} is already building`, activeSlug: active.slug };

  // Newest row decides: a stale needs_review/failed attempt is archived so the
  // retry is not blocked by (or confused with) it.
  const newest = mine.reduce((a, r) => (!a || (Number(r.lastRunAt ?? r.finishedAt ?? 0) >= Number(a.lastRunAt ?? a.finishedAt ?? 0)) ? r : a), null);
  if (newest && RETRYABLE.has(newest.status) && typeof archivePrd === 'function') {
    try { await archivePrd(newest.slug, cwd); } catch { /* best effort */ }
  }

  const slug = `${kebabCase(macro.label, { maxLen: 30, fallback: 'macro' })}-build-${t.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let goal = extra ? `${macro.prompt}\n\nAdditional instructions: ${extra}` : macro.prompt;
  if (entryId) goal += `\n\nEntry id: ${entryId}. Save with ${entryKind === 'video' ? 'videoId' : 'pageId'} = ${entryId}.`;

  const input = {
    title: `${macro.label}: background build`,
    slug,
    cwd,
    agentType: macro.agentName,
    tag: macro.tag,
    deliverable: 'artifact',
    artifactPaths,
    files: artifactPaths,
    estimateMinutes: macro.job.estimateMinutes,
    macroId,
    sourcePromptId: epicId,
    disposition: 'new-head',
    goal,
    acceptanceCriteria: [
      `${artifactPaths[0]} is written during this run by the save tool your persona names, never by hand.`,
      'Nothing in the repository is committed.',
    ],
    implementationNotes:
      `Work as the ${macro.agentName} persona (your system prompt) end to end. This build was started from Project Home and no one is watching: never stop to ask. `
      + 'Build outside the repository (mktemp -d under ~/.cache). SM_PROJECT_ROOT is the project main checkout; the save tool writes there, so omit its cwd.',
    gate: absPaths.map((p) => buildGate(p, t)),
  };

  let res;
  try {
    res = await createPrd(input);
  } catch (e) {
    return { ok: false, error: `createPrd failed: ${e?.message ?? e}` };
  }
  if (!res || res.ok === false) return { ok: false, error: res?.error || 'createPrd failed' };
  return { ok: true, slug, epicId };
}

module.exports = { dispatchMacroJob };
