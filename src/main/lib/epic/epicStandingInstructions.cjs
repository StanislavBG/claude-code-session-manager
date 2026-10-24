'use strict';
/**
 * epicStandingInstructions.cjs — turns an Epic record into the text Session
 * Manager passes as --append-system-prompt on EVERY turn of that Epic, so the
 * Actor's operating rules survive later turns and compaction.
 *
 * buildEpicStandingInstructions is pure; the persona reader is injected.
 */

const HEADER = 'Standing instructions for this Epic (re-sent every turn by Session Manager):';
const MAX_CHARS = 12000;
const TRUNCATION_NOTICE = '\n\n[…standing instructions truncated at 12000 characters]';
const INCLUDED_KINDS = new Set(['actor', 'persona-body', 'injection', 'mission']);

// Must equal CONTEXT_INJECTIONS['delegate-implementation'].text in
// src/renderer/lib/contextInjections.ts (guarded by delegateTextDrift.test.ts).
const DELEGATE_IMPLEMENTATION_TEXT =
  'This interactive session plans and decides; it does not implement. Once scope is clear, ' +
  'queue the implementation as scheduled PRDs via the /develop skill and let it run headless — ' +
  'do not edit application source inline in this conversation. If the scheduler tools are ' +
  'unavailable, say so explicitly rather than falling back to implementing the work yourself.';

function cap(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

function buildEpicStandingInstructions(epic, { readPersonaBody } = {}) {
  if (!epic || typeof epic !== 'object') return null;
  const sections = Array.isArray(epic.sections) ? epic.sections : [];
  const parts = [];
  if (sections.length > 0) {
    for (const s of sections) {
      if (!s || !INCLUDED_KINDS.has(s.kind)) continue;
      const t = typeof s.text === 'string' ? s.text.trim() : '';
      if (t) parts.push(t);
    }
  } else if (epic.agentType && typeof readPersonaBody === 'function') {
    let body = null;
    try { body = readPersonaBody(epic.agentType); } catch { body = null; }
    const t = typeof body === 'string' ? body.trim() : '';
    if (t) parts.push(t);
  }

  const wantsDelegate = epic.tag === 'feature' || epic.tag === 'bug' || epic.agentType === 'architect';
  const hasDelegate = sections.some(
    (s) => s && s.kind === 'injection' && s.source === 'delegate-implementation',
  );
  if (wantsDelegate && !hasDelegate) parts.push(DELEGATE_IMPLEMENTATION_TEXT);

  if (parts.length === 0) return null;
  return cap(`${HEADER}\n\n${parts.join('\n\n')}`);
}

/** Overlay-aware persona body (project .claude/agents wins over ~/.claude/agents), frontmatter stripped. */
function defaultReadPersonaBody(cwd, name) {
  try {
    const { resolveMergedPersona } = require('../persona-macro/personaMerge.cjs');
    const merged = resolveMergedPersona(cwd, name);
    const body = merged && typeof merged.body === 'string' ? merged.body.trim() : '';
    return body || null;
  } catch {
    return null;
  }
}

module.exports = {
  buildEpicStandingInstructions,
  defaultReadPersonaBody,
  DELEGATE_IMPLEMENTATION_TEXT,
  HEADER,
  MAX_CHARS,
};
