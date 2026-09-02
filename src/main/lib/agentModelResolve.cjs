'use strict';

/**
 * agentModelResolve.cjs — resolves the `--model` an Epic's session should
 * launch a headless `claude -p` (or Terminal `claude`) process with: its
 * agentType persona's own `model` field (Agent Library) when the Epic has
 * one set and it isn't 'inherit', else `fallbackModel`.
 *
 * Extracted from PRD agent-model-default-terminal (which wired this for the
 * Terminal-view launch in EpicTerminalPane.tsx) so chatRunner.cjs's headless
 * Chat-view launch resolves the SAME persona-derived model — Chat and
 * Terminal are two VIEWS over one Epic session (CLAUDE.md) and must agree on
 * which model that session launches with.
 *
 * Plain Node module (sync fs) — no Electron deps, mirrors epicMint.cjs's
 * readActiveIndex so this can be called from chatRunner.cjs's synchronous
 * executeRun() without restructuring it into an async flow.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const { readActiveIndex } = require('./epicMint.cjs');
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
      message: `agentType '${agentType}' has no resolvable persona file — model resolution fell back to '${FALLBACK_MODEL}'`,
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
function findAgentTypeByClaudeSessionId(cwd, claudeSessionId, deps = {}) {
  if (!cwd || !claudeSessionId) return null;
  const load = deps.readActiveIndex || readActiveIndex;
  const { sessions } = load(cwd);
  for (const session of Object.values(sessions)) {
    if (session && session.claudeSessionId === claudeSessionId) return session.agentType || null;
  }
  return null;
}

/**
 * Reads a global agent persona's `model` frontmatter field by name
 * (`~/.claude/agents/<agentType>.md`), sync. Returns null on any miss
 * (no such file, unreadable, no `model` key) — never throws.
 */
function readPersonaModel(agentType, deps = {}) {
  if (!agentType) return null;
  const globalDir = deps.globalDir || path.join(os.homedir(), '.claude', 'agents');
  const validatePath = deps.validatePath || configMgr.validatePath;
  let real;
  try {
    real = validatePath(path.join(globalDir, `${agentType}.md`));
  } catch {
    logDanglingPersonaOnce(deps.cwd, agentType);
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch {
    logDanglingPersonaOnce(deps.cwd, agentType);
    return null;
  }
  const { fm } = splitFrontmatter(text);
  return fm.model || null;
}

/**
 * Resolves the `--model` value for an Epic-backed session launch. Never
 * throws — any lookup failure (missing Epic, missing persona, unreadable
 * file) falls back to `fallbackModel` (default: 'sonnet', the same literal
 * every claude -p call site pins per CLAUDE.md's model-pinning rule).
 *
 * @param {{ cwd: string, claudeSessionId: string, fallbackModel?: string, deps?: object }} opts
 * @returns {string}
 */
function resolveEpicModel({ cwd, claudeSessionId, fallbackModel = FALLBACK_MODEL, deps = {} } = {}) {
  try {
    const agentType = findAgentTypeByClaudeSessionId(cwd, claudeSessionId, deps);
    if (!agentType) return fallbackModel;
    const model = readPersonaModel(agentType, { ...deps, cwd });
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
  readPersonaModel,
  resolvePrdPersonaForSpawn,
};
