'use strict';

/**
 * personaMerge.cjs — the ONE place a project-local persona overlay
 * (`<cwd>/.claude/agents/<name>.md`) is combined with the global persona
 * (`~/.claude/agents/<name>.md`). Every reader — agentModelResolve.cjs (model +
 * PRD spawn), agentEffortResolve.cjs, agentLibrary.cjs (getPersonaBody /
 * listPersonas), effectiveModelInfo.cjs — goes through `resolveMergedPersona`;
 * do not add a second merge per reader.
 *
 * MERGE RULES
 *   - Frontmatter: overlay keys override the global's; a key absent from the
 *     overlay (or present with an empty value) falls back to the global.
 *   - Body: an overlay with a non-empty body replaces the global body wholesale
 *     (the pre-merge behavior); a frontmatter-only overlay (`body.trim() === ''`)
 *     inherits the global body.
 *   - `model: inherit` in an overlay is a real value that WINS: it means "defer
 *     to the settings default", NOT "fall back to the global persona's model".
 *     (Callers already treat `inherit` as "use the fallback model".) A project
 *     that wants the global model simply omits the key.
 *   - An overlay with no global counterpart is the whole persona (standalone).
 *   - A MALFORMED overlay (opens a `---` frontmatter fence that never closes)
 *     is ignored, reported once via opsErrorLog, and the global persona
 *     applies — it never throws and never lets a half-parsed file pick the
 *     model. With no global to degrade to, the persona is unresolvable (null).
 *
 * SECURITY: only the two paths `epicMint.cjs`'s `resolvePersonaPaths` yields
 * are ever read, each through `validatePath`, and `PERSONA_NAME_RE` gates the
 * agentType before any path is built — merge never widens what can be read.
 *
 * Sync fs on purpose: `readOverlayAwarePersonaModel` must stay synchronous for
 * chatRunner.cjs's executeRun() (see agentModelResolve.cjs).
 */

const fs = require('node:fs');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const { resolvePersonaPaths } = require('./epicMint.cjs');
const configMgr = require('../config.cjs');

/** Filename-safe persona name: lowercase, hyphenated, matches the `.md` files on disk. */
const PERSONA_NAME_RE = /^[a-z][a-z0-9-]*$/;

const reportedIssues = new Set();

function reportOverlayIssueOnce(cwd, agentType, overlayPath, message) {
  const key = `${cwd}::${agentType}::${message}`;
  if (reportedIssues.has(key)) return;
  reportedIssues.add(key);
  try {
    const { appendError } = require('./opsErrorLog.cjs');
    appendError({
      cwd,
      scope: 'personaMerge',
      level: 'warn',
      message: `project overlay ${overlayPath} for agentType '${agentType}' ${message} — ignored, using the global persona`,
      meta: { agentType, overlayPath },
    });
  } catch { /* reporting must never break resolution */ }
}

/** Raw text of a validated persona path, or null on any miss. */
function readRaw(candidate, validatePath) {
  let real;
  try {
    real = validatePath(candidate);
  } catch {
    return null;
  }
  try {
    return { path: real, text: fs.readFileSync(real, 'utf8') };
  } catch {
    return null;
  }
}

/** True when the text opens a `---` frontmatter fence that splitFrontmatter could not parse. */
function hasMalformedFrontmatter(text) {
  return text.trimStart().startsWith('---') && splitFrontmatter(text).fmLineCount === 0;
}

/** Re-serializes merged frontmatter + body into `.md` text (used only when a merge actually happened). */
function serializeMerged(fm, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  return `${lines.join('\n')}${body.trim()}\n`;
}

/**
 * @param {string} cwd
 * @param {string} agentType
 * @param {{ validatePath?: Function, resolvePersonaPaths?: Function, globalDir?: string, projectDir?: string }} [deps]
 * @returns {null | {
 *   fm: Record<string,string>, body: string, text: string, path: string,
 *   overlayPath: string|null, globalPath: string|null,
 *   fromOverlay: boolean, bodySource: 'overlay'|'global',
 *   provenance: Record<string,'overlay'|'global'>, overlayIssue: string|null,
 * }}
 *   `path` is the file the BODY came from; `text` is that file's raw text when
 *   no merge changed anything (so a full-body overlay resolves byte-identically
 *   to the pre-merge behavior), else the re-serialized merged persona.
 *   Null on invalid name / total miss. Never throws.
 */
function resolveMergedPersona(cwd, agentType, deps = {}) {
  try {
    if (!agentType || !PERSONA_NAME_RE.test(agentType)) return null;
    const validatePath = deps.validatePath || configMgr.validatePath;
    const resolvePaths = deps.resolvePersonaPaths || resolvePersonaPaths;
    const { projectPath, globalPath } = resolvePaths(cwd, agentType, deps);

    const overlayRaw = projectPath ? readRaw(projectPath, validatePath) : null;
    const globalRaw = readRaw(globalPath, validatePath);

    let overlayIssue = null;
    let overlay = null;
    if (overlayRaw) {
      if (hasMalformedFrontmatter(overlayRaw.text)) {
        overlayIssue = 'has malformed frontmatter (unclosed --- fence)';
        reportOverlayIssueOnce(cwd, agentType, overlayRaw.path, overlayIssue);
      } else {
        overlay = { ...splitFrontmatter(overlayRaw.text), path: overlayRaw.path, text: overlayRaw.text };
      }
    }
    const global = globalRaw ? { ...splitFrontmatter(globalRaw.text), path: globalRaw.path, text: globalRaw.text } : null;

    const base = { overlayPath: overlay ? overlay.path : null, globalPath: global ? global.path : null, overlayIssue };

    if (!overlay && !global) return null;
    if (!overlay) {
      const provenance = Object.fromEntries(Object.keys(global.fm).map((k) => [k, 'global']));
      return { ...base, fm: global.fm, body: global.body, text: global.text, path: global.path, fromOverlay: false, bodySource: 'global', provenance };
    }
    if (!global) {
      const provenance = Object.fromEntries(Object.keys(overlay.fm).map((k) => [k, 'overlay']));
      return { ...base, fm: overlay.fm, body: overlay.body, text: overlay.text, path: overlay.path, fromOverlay: true, bodySource: 'overlay', provenance };
    }

    const fm = { ...global.fm };
    const provenance = Object.fromEntries(Object.keys(global.fm).map((k) => [k, 'global']));
    for (const [k, v] of Object.entries(overlay.fm)) {
      if (typeof v !== 'string' || v.trim() === '') continue; // empty value == absent key
      fm[k] = v;
      provenance[k] = 'overlay';
    }
    const overlayHasBody = overlay.body.trim() !== '';
    const body = overlayHasBody ? overlay.body : global.body;
    const bodySource = overlayHasBody ? 'overlay' : 'global';
    // A full-body overlay keeps its raw text (byte-identical to pre-merge); only a
    // frontmatter-only overlay needs a synthesized merged text.
    const text = overlayHasBody ? overlay.text : serializeMerged(fm, body);
    return {
      ...base,
      fm,
      body,
      text,
      path: overlayHasBody ? overlay.path : global.path,
      fromOverlay: true,
      bodySource,
      provenance,
    };
  } catch {
    return null;
  }
}

module.exports = { resolveMergedPersona, PERSONA_NAME_RE };
