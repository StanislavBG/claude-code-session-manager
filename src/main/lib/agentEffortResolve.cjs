'use strict';

/**
 * agentEffortResolve.cjs — the effort twin of agentModelResolve.cjs: resolves
 * the `--effort <level>` an Epic-/PRD-backed `claude` launch should carry,
 * from the agentType persona's own `effort:` frontmatter field (written by
 * agentLibrary.cjs's serializePersona; the key is literally `effort`).
 *
 * PRECEDENCE (explicit):
 *   1. persona `effort:` — project overlay (`<cwd>/.claude/agents/<name>.md`)
 *      beats the global `~/.claude/agents/<name>.md` (same path resolver and
 *      same reader as the model path: agentModelResolve.cjs's
 *      readOverlayAwarePersona — one implementation, not a copy).
 *   2. `inherit`, absent, dangling agentType, unreadable persona → `effort:
 *      null`, meaning "pass NO --effort flag at all" so the CLI applies its
 *      own settings.json / default resolution.
 *
 * This module NEVER reads settings.json and NEVER invents a fallback level.
 * A caller must append the flag only when `effort` is a non-null string —
 * never `--effort inherit`, `--effort null`, or an empty value.
 *
 * The persona value is passed through UNCHANGED (only trimmed): the CLI
 * accepts low/medium/high/xhigh/max and, for an unknown level, merely warns
 * (`Unknown --effort value 'x' — ignoring it and using the default effort.`)
 * and proceeds at the default — so a wrong value degrades gracefully instead
 * of failing the run, and rewriting it here would hide the mistake.
 *
 * Plain sync Node module, never throws (same contract as resolveEpicModel).
 */

const { findAgentTypeByClaudeSessionId, readOverlayAwarePersona } = require('./agentModelResolve.cjs');

// `auto` is a `/effort` RESET verb, not a `--effort` value; it must never reach argv.
const NON_FLAG_EFFORT = new Set(['inherit', 'auto']);

const NO_EFFORT = Object.freeze({ effort: null, source: null });

/**
 * @param {{ cwd: string, claudeSessionId?: string, agentType?: string|null, deps?: object }} opts
 *   `agentType` wins when given (scheduler PRD path); otherwise it is joined
 *   from the Epic's `claudeSessionId` (Chat/Terminal path).
 * @returns {{ effort: string|null, source: 'persona'|'persona-overlay'|'inherit'|null }}
 *   source null = no agentType/persona resolved; 'inherit' = persona present
 *   but sets no level.
 */
function resolveEpicEffort({ cwd, claudeSessionId, agentType, deps = {} } = {}) {
  try {
    const type = agentType || findAgentTypeByClaudeSessionId(cwd, claudeSessionId, deps);
    if (!type) return { ...NO_EFFORT };
    const persona = readOverlayAwarePersona(type, { ...deps, cwd });
    if (!persona) return { ...NO_EFFORT };
    const raw = typeof persona.fm.effort === 'string' ? persona.fm.effort.trim() : '';
    if (!raw || NON_FLAG_EFFORT.has(raw.toLowerCase())) return { effort: null, source: 'inherit' };
    return { effort: raw, source: persona.fromOverlay ? 'persona-overlay' : 'persona' };
  } catch {
    return { ...NO_EFFORT };
  }
}

/** argv fragment for a resolved effort: `['--effort', level]` or `[]`. One place decides the "no flag" rule. */
function effortArgs(effort) {
  return typeof effort === 'string' && effort && !NON_FLAG_EFFORT.has(effort.toLowerCase()) ? ['--effort', effort] : [];
}

module.exports = { resolveEpicEffort, effortArgs };
