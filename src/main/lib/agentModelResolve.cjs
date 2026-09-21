'use strict';

/**
 * agentModelResolve.cjs — resolves the `--model` an Epic's session should
 * launch a headless `claude -p` (or Terminal `claude`) process with: its
 * agentType persona's own `model` field, project-overlay-then-global
 * (`epicMint.cjs`'s `resolvePersonaPaths`), when the Epic has one set and
 * it isn't 'inherit', else `fallbackModel`.
 *
 * Extracted from PRD agent-model-default-terminal (which wired this for the
 * Terminal-view launch in EpicTerminalPane.tsx) so chatRunner.cjs's headless
 * Chat-view launch resolves the SAME persona-derived model — Chat and
 * Terminal are two VIEWS over one Epic session (CLAUDE.md) and must agree on
 * which model that session launches with. Terminal reaches `resolveEpicModel`
 * through the `agents:resolve-epic-model` IPC (main-process only; the
 * renderer has no fs access) rather than a second implementation, so the two
 * views literally call the same function instead of two functions that are
 * merely supposed to agree.
 *
 * PRECEDENCE (explicit): Epic-level `model` (the New Session card's override,
 * stored on the Epic record) > persona frontmatter `model` > `fallbackModel`.
 * An Epic with no `model` key (every Epic minted before the override existed)
 * resolves exactly as it always did.
 *
 * Plain Node module (sync fs) — no Electron deps, mirrors epicMint.cjs's
 * readActiveIndex so this can be called from chatRunner.cjs's synchronous
 * executeRun() without restructuring it into an async flow.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const { readActiveIndex, resolvePersonaPaths } = require('./epicMint.cjs');
const { PERSONA_NAME_RE } = require('../agentLibrary.cjs');
const configMgr = require('../config.cjs');

/** The hardcoded floor every branch of resolveEpicModel falls back to — --model must never be omitted (CLAUDE.md "Automation model pinning"). */
const FALLBACK_MODEL = 'sonnet';

// READ side of the agentType FK (write side: epicMint.cjs's ensureEpic —
// "throw on write, report on read"). A persona can legitimately be renamed
// or deleted after an Epic was created against it; that Epic must keep
// loading (this module's whole contract is "never throws"), but the
// dangling reference should still be visible somewhere. Logged at most once
// per (cwd, agentType) so a headless launch that resolves the same Epic's
// model on every turn doesn't flood opsErrorLog's daily file.
const loggedDanglingPersonas = new Set();

function logDanglingPersonaOnce(cwd, agentType) {
  if (!cwd || !agentType) return;
  const key = `${cwd}::${agentType}`;
  if (loggedDanglingPersonas.has(key)) return;
  loggedDanglingPersonas.add(key);
  try {
    // Required lazily: opsErrorLog.cjs is a leaf module with no Electron
    // dependency, but keeping this require inside the miss path avoids
    // paying for it on the (overwhelmingly common) hit path.
    const { appendError } = require('./opsErrorLog.cjs');
    appendError({
      cwd,
      scope: 'agentModelResolve',
      level: 'warn',
      message: `agentType '${agentType}' has no resolvable persona file — model resolution fell back to '${FALLBACK_MODEL}' (and no persona effort applies)`,
      meta: { agentType },
    });
  } catch { /* logging must never break model resolution */ }
}

/**
 * Looks up the agentType an Epic (PromptSession) was created with, by the
 * Epic's own claudeSessionId — the same domain-model join `prdCreate.cjs`'s
 * resolveSourcePromptIdFromClaudeSession uses (Epic:claude-session is 1:1).
 * Returns null if no matching Epic is found or it has no agentType set.
 */
function findEpicByClaudeSessionId(cwd, claudeSessionId, deps = {}) {
  if (!cwd || !claudeSessionId) return null;
  const load = deps.readActiveIndex || readActiveIndex;
  const { sessions } = load(cwd);
  for (const session of Object.values(sessions)) {
    if (session && session.claudeSessionId === claudeSessionId) return session;
  }
  return null;
}

function findAgentTypeByClaudeSessionId(cwd, claudeSessionId, deps = {}) {
  return findEpicByClaudeSessionId(cwd, claudeSessionId, deps)?.agentType || null;
}

/** A non-empty trimmed string from an Epic's optional `model`/`effort` override field, else null. */
function epicOverrideValue(epic, field) {
  const raw = epic && typeof epic[field] === 'string' ? epic[field].trim() : '';
  return raw || null;
}

/**
 * Shared miss-tolerant persona reader (model AND effort resolution both go
 * through it — one concept, one implementation): tries each candidate path in
 * order (`validatePath` then sync `readFileSync`) and returns the FIRST
 * readable file's parsed frontmatter plus which candidate won — even if the
 * field a caller cares about is absent, which is why an empty-`model` overlay
 * file does NOT fall through to a later candidate (matches `getPersonaBody`'s
 * own semantics). Logs the dangling-persona warning at most once per
 * `(deps.cwd, agentType)` only when EVERY candidate misses. Never throws.
 */
function readFrontmatterFromCandidatePaths(candidates, agentType, deps) {
  const validatePath = deps.validatePath || configMgr.validatePath;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    let real;
    try {
      real = validatePath(candidate);
    } catch {
      continue;
    }
    try {
      const text = fs.readFileSync(real, 'utf8');
      const { fm } = splitFrontmatter(text);
      return { fm, path: real, candidateIndex: i };
    } catch {
      continue;
    }
  }
  logDanglingPersonaOnce(deps.cwd, agentType);
  return null;
}

/**
 * Reads an Epic's agentType persona's frontmatter with the SAME
 * project-overlay-then-global precedence `agentLibrary.cjs`'s `getPersonaBody`
 * (and, through it, `resolvePrdPersonaForSpawn` below) already applies for a
 * scheduled PRD — `epicMint.cjs`'s `resolvePersonaPaths` is the shared path
 * resolver both readers go through, so there is exactly one place that decides
 * which of the two files wins. Returns `{ fm, path, fromOverlay }`, or null on
 * a total miss / invalid name — never throws.
 *
 * Sync (not `getPersonaBody`'s async `fsp.readFile`) because `resolveEpicModel`
 * must stay synchronous: `chatRunner.cjs`'s `executeRun()` registers its
 * cancel handle into `inFlight` synchronously, and its caller (`pump()`) reads
 * that entry back immediately after invoking the executor — an `await`
 * inserted ahead of that registration would run it a tick late and silently
 * break `cancel()`.
 */
function readOverlayAwarePersona(agentType, deps = {}) {
  // Same guard agentLibrary.cjs's getPersonaBody applies before it joins
  // `name` into a path: without it, a caller-supplied agentType like
  // "../../other-project/CLAUDE" survives resolvePersonaPaths' plain
  // path.join and validatePath's allowed-roots check (which only confirms
  // the resolved path stays under the home dir / an opened project), letting
  // any readable .md under those roots be read on this spawn path.
  if (!agentType || !PERSONA_NAME_RE.test(agentType)) return null;
  const resolvePaths = deps.resolvePersonaPaths || resolvePersonaPaths;
  const { projectPath, globalPath } = resolvePaths(deps.cwd, agentType, deps);
  // A null projectPath (no cwd) simply has no overlay candidate.
  const candidates = projectPath ? [projectPath, globalPath] : [globalPath];
  const hit = readFrontmatterFromCandidatePaths(candidates, agentType, deps);
  if (!hit) return null;
  return { fm: hit.fm, path: hit.path, fromOverlay: Boolean(projectPath) && hit.candidateIndex === 0 };
}

/** The persona's `model` frontmatter field (overlay-then-global), or null. Never throws. */
function readOverlayAwarePersonaModel(agentType, deps = {}) {
  const persona = readOverlayAwarePersona(agentType, deps);
  return (persona && persona.fm.model) || null;
}

/**
 * True when `personaPath` (an already-resolved persona file path, e.g. from
 * agentLibrary.cjs's getPersonaBody) is the PROJECT overlay candidate rather
 * than the global one — the same "which of resolvePersonaPaths' two
 * candidates won" question readModelFromCandidatePaths above answers
 * structurally by trying the project path first. Exported so a caller that
 * already has a resolved persona path from a DIFFERENT reader (one that
 * needs async I/O or richer provenance than this module's sync
 * readOverlayAwarePersonaModel returns — e.g. effectiveModelInfo.cjs) can
 * ask this module the overlay question instead of re-deriving its own
 * resolvePersonaPaths-based comparison. Never throws; a resolution failure
 * conservatively answers "not overlay" (assume global).
 */
function isProjectOverlayPersonaPath(cwd, agentType, personaPath, deps = {}) {
  if (!personaPath) return false;
  try {
    const resolvePaths = deps.resolvePersonaPaths || resolvePersonaPaths;
    const { projectPath } = resolvePaths(cwd, agentType, deps);
    return Boolean(projectPath) && path.resolve(projectPath) === path.resolve(personaPath);
  } catch {
    return false;
  }
}

/**
 * Resolves the `--model` value for an Epic-backed session launch. Never
 * throws — any lookup failure (missing Epic, missing persona, unreadable
 * file) falls back to `fallbackModel` (default: 'sonnet', the same literal
 * every claude -p call site pins per CLAUDE.md's model-pinning rule).
 *
 * This is the SINGLE authority both Chat (`chatRunner.cjs`, in-process) and
 * Terminal (`EpicTerminalPane.tsx`, via the `agents:resolve-epic-model` IPC
 * added in the same change) call for an Epic-backed launch, so the two views
 * of one Epic agree on which model that session launches with — see this
 * module's header.
 *
 * @param {{ cwd: string, claudeSessionId: string, fallbackModel?: string, deps?: object }} opts
 * @returns {string}
 */
function resolveEpicModel({ cwd, claudeSessionId, fallbackModel = FALLBACK_MODEL, deps = {} } = {}) {
  try {
    const epic = findEpicByClaudeSessionId(cwd, claudeSessionId, deps);
    const override = epicOverrideValue(epic, 'model');
    if (override && override !== 'inherit') return override;
    const agentType = epic?.agentType || null;
    if (!agentType) return fallbackModel;
    const model = readOverlayAwarePersonaModel(agentType, { ...deps, cwd });
    if (!model || model === 'inherit') return fallbackModel;
    return model;
  } catch {
    return fallbackModel;
  }
}

/** Mirrors epicIntake.ts's AGENT_BODY_CHAR_CAP — a runaway persona file must
 *  not be able to dominate a spawned job's system prompt either. Duplicated
 *  rather than imported: epicIntake.ts is a renderer module (no ES modules
 *  in main). */
const AGENT_BODY_CHAR_CAP = 6000;

/** Trims a persona's frontmatter-stripped body and caps it at
 *  AGENT_BODY_CHAR_CAP, appending a truncation notice naming `personaPath`
 *  — same shape as epicIntake.ts's buildPersonaBodyText. Returns null for an
 *  empty body. */
function buildPersonaBodyText(rawBody, personaPath) {
  const body = (rawBody || '').trim();
  if (!body) return null;
  if (body.length <= AGENT_BODY_CHAR_CAP) return body;
  const truncated = body.slice(0, AGENT_BODY_CHAR_CAP);
  const pathLabel = personaPath || 'the persona file';
  return `${truncated}\n\n[Truncated — ${pathLabel} exceeds ${AGENT_BODY_CHAR_CAP} characters; see the file for the full body.]`;
}

/**
 * Resolves the persona system-prompt + model a scheduled PRD's `agentType`
 * should launch its headless `claude -p` spawn with. Never throws — a
 * missing agentType, or one that no longer resolves to a readable persona
 * file (renamed/deleted), falls back to `{ systemPrompt: null, model:
 * fallbackModel, personaPath: null }` and logs once via prdAgentType.cjs's
 * reportDanglingAgentTypeOnce (the PRD-frontmatter FK's own dangling-read
 * convention) — a dangling persona must never park or fail the job.
 *
 * Reuses agentLibrary.cjs's getPersonaBody (project-overlay-then-global
 * read, same precedence resolvePersonaPaths documents) rather than a second
 * persona-file reader, and this module's own frontmatter-stripped-body cap
 * (mirroring epicIntake.ts's Epic-path treatment) so the PRD path gets the
 * same runaway-file protection.
 *
 * @param {{ cwd: string, agentType: string|null, fallbackModel?: string, deps?: object }} opts
 * @returns {Promise<{ model: string, systemPrompt: string|null, personaPath: string|null }>}
 */
async function resolvePrdPersonaForSpawn({ cwd, agentType, fallbackModel = FALLBACK_MODEL, deps = {} } = {}) {
  const miss = { model: fallbackModel, systemPrompt: null, personaPath: null };
  if (!agentType) return miss;
  try {
    const getBody = deps.getPersonaBody || require('../agentLibrary.cjs').getPersonaBody;
    const persona = await getBody({ cwd, name: agentType });
    if (!persona) {
      const reportOnce = deps.reportDanglingAgentTypeOnce || require('./prdAgentType.cjs').reportDanglingAgentTypeOnce;
      reportOnce(cwd, agentType, deps);
      return miss;
    }
    const { fm, body } = splitFrontmatter(persona.text);
    const model = fm.model && fm.model !== 'inherit' ? fm.model : fallbackModel;
    const systemPrompt = buildPersonaBodyText(body, persona.path);
    return { model, systemPrompt, personaPath: persona.path };
  } catch {
    return miss;
  }
}

module.exports = {
  FALLBACK_MODEL,
  resolveEpicModel,
  findAgentTypeByClaudeSessionId,
  findEpicByClaudeSessionId,
  epicOverrideValue,
  readOverlayAwarePersonaModel,
  readOverlayAwarePersona,
  isProjectOverlayPersonaPath,
  resolvePrdPersonaForSpawn,
};
