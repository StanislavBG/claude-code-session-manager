'use strict';

/**
 * macroJobDispatch.cjs — turn a built-in macro press into ONE artifact-only
 * scheduler PRD inside an existing Epic, so the build runs headless as the
 * macro's persona under the scheduler's budget instead of a chat turn.
 * Never mints an Epic (single-creator law): the caller supplies epicId.
 * A press may carry a lower per-run effort, written as the PRD's `effort` frontmatter.
 * A project's own Video tool (library macro, surface 'project-video', projects
 * [cwd], with a job) dispatches the same way: artifact-only, or a committing PRD
 * when job.repoPaths is set, with an optional review stage when job.review is set.
 * A built-in whose job.reviewable is true (Demo Video) runs that same review
 * stage when the press passes reviewStage: true or a review decision.
 * A project Video tool's job gets voiceId = the press's voiceId, else the tool's
 * default voiceId, else nothing; handed to createPrd as `voiceId` (PRD
 * frontmatter, which the scheduler exports as SM_VOICE_ID) and named in the
 * job's implementation notes as a 'Voice: <id>' line.
 *
 * Plain Node, no Electron imports; all I/O is injected.
 */

const path = require('node:path');
const { BUILTIN_MACROS } = require('./builtinMacros.cjs');
const { kebabCase } = require('../util/kebabCase.cjs');
const { PRD_EFFORT_LEVELS } = require('../prd/prdFrontmatter.cjs');
const { renderMacroPrompt, VOICE_ID_RE } = require('./macroLibrary.cjs');

const ACTIVE = new Set(['pending', 'held', 'running']);
const RETRYABLE = new Set(['needs_review', 'failed']);

// One path keeps the original single-stat script. Alternatives (Demo Video:
// the stage artifact OR outcome.json) pass when ANY is fresh (size > 0,
// mtime after dispatch); a missing alternative counts as not fresh.
function buildGate(absPaths, nowMs) {
  const list = Array.isArray(absPaths) ? absPaths : [absPaths];
  // No shell: everything with shell characters sits inside single quotes, so
  // the script itself uses double quotes only (JSON.stringify) and never a
  // single quote.
  const script = list.length === 1
    ? `const s=require("fs").statSync(${JSON.stringify(list[0])});process.exit(s.size>0&&s.mtimeMs>${nowMs}?0:1)`
    : `const f=require("fs");process.exit(${JSON.stringify(list)}.some((p)=>{try{const s=f.statSync(p);return s.size>0&&s.mtimeMs>${nowMs}}catch{return false}})?0:1)`;
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

const VIDEO_INDEX_REL = 'session-manager-operations/project-pages/videos/{id}/index.html';
// Same string as video-review-store's REVIEW_MATERIAL_REL (asserted by the IPC wiring test).
const REVIEW_MATERIAL_REL = 'session-manager-operations/project-pages/videos/{id}/review/material.json';
// Written by project_video_outcome_write (projectHomeAdminRoutes.cjs): a run that
// ends with a saved outcome (season-complete) and no video on purpose.
const OUTCOME_REL = 'session-manager-operations/project-pages/videos/{id}/outcome.json';
const OUTCOME_MACRO_ID = 'builtin-demo-video';

const oneLine = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();

// A caller can never forge a review decision: every 'Review:' line goes, and
// only the internal `review` param writes one back.
function stripReviewLines(extra) {
  return extra.split(/\r?\n/).filter((l) => !/^\s*review:/i.test(l)).join('\n').trim();
}

function reviewLine(review) {
  if (!review || typeof review !== 'object') return '';
  if (review.decision === 'approved' && typeof review.at === 'string' && oneLine(review.at)) {
    return `Review: approved by the owner at ${oneLine(review.at)}`;
  }
  if (review.decision === 'changes' && typeof review.note === 'string' && oneLine(review.note)) {
    return `Review: changes requested: ${oneLine(review.note)}`;
  }
  return '';
}

// A project's own Video tool: only from the library, only on the Video surface,
// only for exactly this project, only with a job declaration.
function resolveProjectTool(macros, macroId, cwd) {
  const m = (Array.isArray(macros) ? macros : []).find((x) => x && x.id === macroId);
  if (!m || m.builtin || m.surface !== 'project-video' || !m.job || typeof m.job !== 'object') return null;
  if (!Array.isArray(m.projects) || m.projects.length !== 1 || m.projects[0] !== cwd) return null;
  return m;
}

// Review stage: a project tool with job.review always reviews first; a built-in
// with job.reviewable reviews only when the press opts in (reviewStage === true)
// or a 'changes' decision sends it back. An approved review is the final build.
function stageFor(tool, builtin, review, reviewStage) {
  const decision = review && typeof review === 'object' ? review.decision : undefined;
  if (tool) return tool.job.review ? (decision === 'approved' ? 'final' : 'review') : null;
  if (!builtin || builtin.job.reviewable !== true) return null;
  if (decision === 'approved') return 'final';
  return reviewStage === true || decision === 'changes' ? 'review' : null;
}

async function dispatchMacroJob(
  { cwd, macroId, epicId, extraInstructions, effort, inputValues, review, reviewStage, voiceId } = {},
  { createPrd, listRows, archivePrd, builtins = BUILTIN_MACROS, macros = [], now = Date.now } = {},
) {
  const builtin = (builtins || []).find((m) => m && m.id === macroId);
  const tool = builtin ? null : resolveProjectTool(macros, macroId, cwd);
  const macro = builtin || tool;
  if (!macro || !macro.job) return { ok: false, error: `macro ${macroId} has no background job declaration` };
  if (typeof epicId !== 'string' || !epicId.trim()) return { ok: false, error: 'epicId is required — a background build joins an existing Epic' };
  if (typeof cwd !== 'string' || !cwd) return { ok: false, error: 'cwd is required' };
  if (voiceId != null && (typeof voiceId !== 'string' || !VOICE_ID_RE.test(voiceId))) {
    return { ok: false, error: 'voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/ when given' };
  }
  if (typeof createPrd !== 'function') return { ok: false, error: 'createPrd is not available' };

  let prompt = macro.prompt;
  if (tool) {
    const r = renderMacroPrompt(tool.prompt, tool.inputs, inputValues);
    if (!r.ok) return { ok: false, error: r.error };
    prompt = r.prompt;
  }

  const t = now();
  const rLine = reviewLine(review);
  const extra = [stripReviewLines(typeof extraInstructions === 'string' ? extraInstructions : ''), rLine].filter(Boolean).join('\n');
  const entryKind = tool ? 'video' : macro.job.entryKind;
  const entryId = entryKind ? entryIdFor(entryKind, extra, t) : null;
  const stage = stageFor(tool, builtin, review, reviewStage);
  const repoPaths = tool && Array.isArray(tool.job.repoPaths) && tool.job.repoPaths.length ? tool.job.repoPaths.slice() : null;
  const artifactPaths = tool || stage === 'review'
    ? [(stage === 'review' ? REVIEW_MATERIAL_REL : VIDEO_INDEX_REL).split('{id}').join(entryId)]
    : macro.job.artifactPaths.map((p) => (entryId ? p.split('{id}').join(entryId) : p));
  const absPaths = artifactPaths.map((p) => path.join(cwd, p));
  // Built-in Demo Video only: a saved outcome is an alternative pass for every gate.
  const outcomeRel = builtin && macroId === OUTCOME_MACRO_ID && entryId ? OUTCOME_REL.split('{id}').join(entryId) : null;
  const outcomeAbs = outcomeRel ? path.join(cwd, outcomeRel) : null;
  for (const s of [cwd, ...absPaths, ...(outcomeAbs ? [outcomeAbs] : [])]) {
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
  let goal = extra ? `${prompt}\n\nAdditional instructions: ${extra}` : prompt;
  if (entryId) goal += `\n\nEntry id: ${entryId}. Save with ${entryKind === 'video' ? 'videoId' : 'pageId'} = ${entryId}.`;
  if (stage === 'review') {
    goal += `\n\nReview stage: save the review material for entry ${entryId} with one project_video_review_write call (images and short text), then end; do not build or save the video in this run.`;
  }

  const saveTool = stage === 'review' ? 'the project_video_review_write tool' : 'the save tool your persona names';
  const input = {
    title: `${macro.label}: ${stage === 'review' ? 'review material' : 'background build'}`,
    slug,
    cwd,
    agentType: macro.agentName,
    tag: macro.tag,
    estimateMinutes: macro.job.estimateMinutes,
    macroId,
    sourcePromptId: epicId,
    disposition: 'new-head',
    goal,
    gate: absPaths.map((p) => buildGate(outcomeAbs ? [p, outcomeAbs] : [p], t)),
  };
  if (repoPaths) {
    Object.assign(input, {
      files: repoPaths,
      acceptanceCriteria: [
        `${artifactPaths[0]} is written during this run by ${saveTool}, never by hand. That entry is saved by the save tool and is never committed.`,
        `This run must commit its changes under ${repoPaths.join(', ')} (stage only those paths). With nothing to commit it fails like any PRD.`,
      ],
      implementationNotes:
        `Work as the ${macro.agentName} persona (your system prompt) end to end. This build was started from Project Home and no one is watching: never stop to ask. `
        + 'SM_PROJECT_ROOT is the project main checkout; the save tool writes there, so omit its cwd. '
        + `This build lands a commit: change files only under ${repoPaths.join(', ')}, commit them, and never commit the saved entry.`,
    });
  } else {
    Object.assign(input, {
      deliverable: 'artifact',
      artifactPaths,
      files: artifactPaths,
      acceptanceCriteria: [
        `${artifactPaths[0]} is written during this run by ${saveTool}, never by hand.`,
        'Nothing in the repository is committed. No commit is the expected result: once the gate is green, end with SCHEDULER_VERDICT: PASS, never FAIL for the missing commit.',
        ...(outcomeRel ? [`A saved outcome is a passing result with no video: when a kind playbook says to stop with an outcome, ${outcomeRel} written during this run by project_video_outcome_write passes the gate in place of ${artifactPaths[0]}; save no video or review material and end with SCHEDULER_VERDICT: PASS.`] : []),
      ],
      implementationNotes:
        `Work as the ${macro.agentName} persona (your system prompt) end to end. This build was started from Project Home and no one is watching: never stop to ask. `
        + 'Build outside the repository (mktemp -d under ~/.cache). SM_PROJECT_ROOT is the project main checkout; the save tool writes there, so omit its cwd. '
        + 'This build is artifact-only (deliverable: artifact) and lands no commit by design: a green gate with no commit means SCHEDULER_VERDICT: PASS.',
    });
  }
  if (typeof effort === 'string' && PRD_EFFORT_LEVELS.includes(effort)) input.effort = effort;
  // Press pick beats the tool default; only a project Video tool's job carries a voice.
  const jobVoiceId = tool
    ? (voiceId || (typeof tool.voiceId === 'string' && VOICE_ID_RE.test(tool.voiceId) ? tool.voiceId : null))
    : null;
  if (jobVoiceId) {
    input.voiceId = jobVoiceId;
    input.implementationNotes += ` Voice: ${jobVoiceId} (also in SM_VOICE_ID): speak every narration line with this library voice.`;
  }

  let res;
  try {
    res = await createPrd(input);
  } catch (e) {
    return { ok: false, error: `createPrd failed: ${e?.message ?? e}` };
  }
  if (!res || res.ok === false) return { ok: false, error: res?.error || 'createPrd failed' };
  return { ok: true, slug, epicId, entryId, stage };
}

module.exports = { dispatchMacroJob };
