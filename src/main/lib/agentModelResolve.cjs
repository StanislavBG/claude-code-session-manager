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
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(real, 'utf8');
  } catch {
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
    const model = readPersonaModel(agentType, deps);
    if (!model || model === 'inherit') return fallbackModel;
    return model;
  } catch {
    return fallbackModel;
  }
}

module.exports = {
  FALLBACK_MODEL,
  resolveEpicModel,
  findAgentTypeByClaudeSessionId,
  readPersonaModel,
};
