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

const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { splitFrontmatter } = require('../prd/prdFrontmatter.cjs');
const { readActiveIndex, resolvePersonaPaths } = require('../epic/epicMint.cjs');
const { resolveMergedPersona, PERSONA_NAME_RE } = require('../persona-macro/personaMerge.cjs');
const { readSettingsModel } = require('./modelCatalog.cjs');
const configMgr = require('../../config.cjs');
const { SHIPPED_PERSONA_SEEDS } = require('../persona-macro/shippedPersonaSeeds.cjs');

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
    const { appendError } = require('../telemetry/opsErrorLog.cjs');
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

/**
 * Looks up an Epic (PromptSession) row by its own Epic id — the key of the
 * active index, or a row whose `id` matches. Same reader as
 * findEpicByClaudeSessionId. Returns the row or null; never throws.
 */
function findEpicById(cwd, epicId, deps = {}) {
  if (!cwd || !epicId) return null;
  try {
    const load = deps.readActiveIndex || readActiveIndex;
    const { sessions } = load(cwd);
    if (!sessions || typeof sessions !== 'object') return null;
    const direct = Object.prototype.hasOwnProperty.call(sessions, epicId) ? sessions[epicId] : null;
    if (direct && typeof direct === 'object') return direct;
    for (const session of Object.values(sessions)) {
      if (session && session.id === epicId) return session;
    }
    return null;
  } catch {
    return null;
  }
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
 * Reads an Epic's agentType persona through personaMerge.cjs's
 * `resolveMergedPersona` — the ONE overlay-over-global merge every reader
 * shares (overlay frontmatter keys win, absent keys and an empty overlay body
 * fall back to the global; see that module's header for the `inherit` and
 * malformed-overlay rules). Returns `{ fm, body, path, fromOverlay,
 * provenance, ... }`, or null on a total miss / invalid name — never throws,
 * and logs the dangling-persona warning at most once per (cwd, agentType).
 *
 * Sync (not `getPersonaBody`'s async form) because `resolveEpicModel` must
 * stay synchronous: `chatRunner.cjs`'s `executeRun()` registers its cancel
 * handle into `inFlight` synchronously, and its caller (`pump()`) reads that
 * entry back immediately after invoking the executor — an `await` inserted
 * ahead of that registration would run it a tick late and silently break
 * `cancel()`. The PERSONA_NAME_RE traversal guard lives in the merge module.
 */
function readOverlayAwarePersona(agentType, deps = {}) {
  const persona = resolveMergedPersona(deps.cwd, agentType, deps);
  if (!persona) {
    if (agentType && PERSONA_NAME_RE.test(agentType)) logDanglingPersonaOnce(deps.cwd, agentType);
    return null;
  }
  return persona;
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
    const settingsOrFallback = () => readSettingsModel(cwd, deps) || fallbackModel || FALLBACK_MODEL;
    if (!agentType) return settingsOrFallback();
    const model = readOverlayAwarePersonaModel(agentType, { ...deps, cwd });
    if (!model || model === 'inherit') return settingsOrFallback();
    return model;
  } catch {
    return fallbackModel || FALLBACK_MODEL;
  }
}

/** Mirrors epicIntake.ts's AGENT_BODY_CHAR_CAP — a runaway persona file must
 *  not be able to dominate a spawned job's system prompt either. Duplicated
 *  rather than imported: epicIntake.ts is a renderer module (no ES modules
 *  in main).
 *
 *  EXEMPTION: a body whose digest matches a version the app itself shipped
 *  (SHIPPED_PERSONA_SEEDS) is passed whole — an unedited app-shipped body
 *  cannot be a runaway file, and demo-video-builder's style and palette rules
 *  sit past 6000 chars, so capping it silently drops them. Every other body
 *  (edited, overlay-changed, no manifest entry) stays capped. */
const AGENT_BODY_CHAR_CAP = 6000;

/** sha256 hex of a body (newlines normalized, trimmed). MUST stay the same
 *  digest as seedAgentPersonas.cjs's personaBodyHash (not required here: it
 *  pulls the seeding writers); the unit test enforces the equality. */
function shippedBodyHash(body) {
  const normalized = String(body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(normalized.trim()).digest('hex');
}

/** Trims a persona's frontmatter-stripped body and caps it at
 *  AGENT_BODY_CHAR_CAP (unless `uncapped`), appending a truncation notice
 *  naming `personaPath` — same shape as epicIntake.ts's buildPersonaBodyText.
 *  Returns null for an empty body. */
function buildPersonaBodyText(rawBody, personaPath, { uncapped = false } = {}) {
  const body = (rawBody || '').trim();
  if (!body) return null;
  if (uncapped || body.length <= AGENT_BODY_CHAR_CAP) return body;
  const truncated = body.slice(0, AGENT_BODY_CHAR_CAP);
  const pathLabel = personaPath || 'the persona file';
  return `${truncated}\n\n[Truncated — ${pathLabel} exceeds ${AGENT_BODY_CHAR_CAP} characters; see the file for the full body.]`;
}

/** The persona a PRD with no `agentType` runs as — same default prdAgentType.cjs documents. */
const DEFAULT_PRD_AGENT_TYPE = 'dev-lead';

/**
 * Resolves the persona system-prompt + model a scheduled PRD's `agentType`
 * should launch its headless `claude -p` spawn with. A null/absent agentType
 * resolves as 'dev-lead'.
 *
 * REFUSAL, not fallback (Managed Agents C-rule "an agent definition is
 * validated"): when the persona is missing, unreadable, or its frontmatter
 * fails personaFrontmatterSchema.cjs's validatePersonaFrontmatter, this
 * returns `{ refusal: { code: 'persona_missing'|'persona_invalid', detail },
 * model: null, systemPrompt: null, personaPath, tools: null }` — the scheduler
 * parks the job instead of spawning it as "no persona + sonnet". A dangling
 * agentType is still logged once via prdAgentType.cjs's
 * reportDanglingAgentTypeOnce (the read-time log). Never throws.
 *
 * Reuses agentLibrary.cjs's getPersonaBody (project-overlay-then-global
 * read) and this module's frontmatter-stripped-body cap.
 *
 * @param {{ cwd: string, agentType: string|null, deps?: object }} opts
 * @returns {Promise<{ model: string|null, systemPrompt: string|null, personaPath: string|null, tools: string[]|null, loadout?: 'undecided'|'bare'|'equipped'|'unbound', refusal: null|{ code: 'persona_missing'|'persona_invalid', detail: string } }>}
 */
async function resolvePrdPersonaForSpawn({ cwd, agentType, deps = {} } = {}) {
  const name = agentType || DEFAULT_PRD_AGENT_TYPE;
  const refuse = (code, detail, personaPath = null) => ({
    model: null, systemPrompt: null, personaPath, tools: null, refusal: { code, detail },
  });
  let persona;
  try {
    const getBody = deps.getPersonaBody || require('../../agentLibrary.cjs').getPersonaBody;
    persona = await getBody({ cwd, name });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return refuse('persona_missing', `agentType '${name}' persona could not be read: ${msg}`);
  }
  if (!persona) {
    try {
      const reportOnce = deps.reportDanglingAgentTypeOnce || require('../prd/prdAgentType.cjs').reportDanglingAgentTypeOnce;
      reportOnce(cwd, name, deps);
    } catch { /* the read-time log must never change the result */ }
    return refuse('persona_missing', `agentType '${name}' does not resolve to a readable persona file`);
  }
  try {
    // getPersonaBody returns the MERGED persona (fm + body); a bare `{ path, text }`
    // (older injected reader) is parsed here.
    const { fm, body } = persona.fm ? persona : splitFrontmatter(persona.text);
    const validate = deps.validatePersonaFrontmatter
      || require('../persona-macro/personaFrontmatterSchema.cjs').validatePersonaFrontmatter;
    const check = validate(fm);
    if (!check.ok) {
      return refuse('persona_invalid', `agentType '${name}' persona ${persona.path || '(unknown path)'} frontmatter is invalid: ${check.errors.join('; ')}`, persona.path || null);
    }
    const model = String(fm.model).trim();
    const digest = shippedBodyHash(body);
    const uncapped = (SHIPPED_PERSONA_SEEDS[name] || []).some((e) => e.bodySha256 === digest);
    const systemPrompt = buildPersonaBodyText(body, persona.path, { uncapped });
    const parseTools = deps.parseTools || require('../../agentLibrary.cjs').parseTools;
    const list = parseTools(typeof fm.tools === 'string' ? fm.tools : '');
    const { loadoutState } = require('../persona-macro/personaLoadout.cjs');
    return { model, systemPrompt, personaPath: persona.path, tools: list.length ? list : null, loadout: loadoutState(fm), refusal: null };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return refuse('persona_invalid', `agentType '${name}' persona ${persona.path || '(unknown path)'} could not be parsed: ${msg}`, persona.path || null);
  }
}

module.exports = {
  FALLBACK_MODEL,
  AGENT_BODY_CHAR_CAP,
  shippedBodyHash,
  resolveEpicModel,
  findAgentTypeByClaudeSessionId,
  findEpicByClaudeSessionId,
  findEpicById,
  epicOverrideValue,
  readOverlayAwarePersonaModel,
  readOverlayAwarePersona,
  isProjectOverlayPersonaPath,
  resolvePrdPersonaForSpawn,
  DEFAULT_PRD_AGENT_TYPE,
  // The frontmatter parser dispatch validates personas with — re-exported so
  // tests parse tracked personas the same way (trackedPersonasValid.test.cjs).
  splitFrontmatter,
};
