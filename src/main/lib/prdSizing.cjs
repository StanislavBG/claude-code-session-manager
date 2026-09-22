/**
 * prdSizing.cjs — pure PRD-size warning rules (PRD 1403).
 *
 * The measured actual/estimate ratio across scheduler runs sits at 0.24 (p50) with 60% of
 * jobs finishing in <=10 min, yet nothing at the authoring gate flags an oversized PRD before
 * it lands. `sizingWarnings` is the single rule set; prdCreate.cjs's createPrd() surfaces its
 * output in the create-prd response, and scheduler-mcp-server.cjs's scheduler_create_prd
 * handler prints it as a "Sizing warnings:" block. Warnings never block a write.
 */
'use strict';

const SIZING_LIMITS = {
  estimateMinutes: 15,
  acLines: 8,
  acLineChars: 400,
  bodyChars: 7000,
};

// Open-ended search-and-fix shape, e.g. "grep the codebase and update every call site." Matches
// across sentence boundaries within one AC line ([\s\S]*, not [^.]*) — a natural two-sentence
// phrasing like "Search the codebase for X. Update every call site." is exactly the shape this
// rule exists to catch, and a period must not be enough to dodge it.
const OPEN_ENDED_RE = /\b(grep|search|scan|audit|find)\b[\s\S]*\b(and|then)\b[\s\S]*\b(update|fix|adjust|migrate|change)\b/i;
const TIMEOUT_CMD_RE = /\btimeout\s+\d+/gi;

/**
 * Pure — no I/O. Returns one human-readable warning per triggered rule, `[]` when nothing
 * is triggered. `input` mirrors createPrd()'s own input shape; missing/non-array fields are
 * treated as empty/absent rather than thrown on, since this is advisory only.
 */
function sizingWarnings(input) {
  const { estimateMinutes, goal, implementationNotes } = input || {};
  const acceptanceCriteria = Array.isArray(input?.acceptanceCriteria) ? input.acceptanceCriteria : [];
  const acLines = acceptanceCriteria.filter((line) => typeof line === 'string');

  const warnings = [];

  if (typeof estimateMinutes === 'number' && estimateMinutes > SIZING_LIMITS.estimateMinutes) {
    warnings.push(
      `estimateMinutes (${estimateMinutes}) exceeds the ${SIZING_LIMITS.estimateMinutes}-minute sizing limit — split this PRD into smaller work items.`,
    );
  }

  if (acceptanceCriteria.length > SIZING_LIMITS.acLines) {
    warnings.push(
      `acceptanceCriteria has ${acceptanceCriteria.length} lines, exceeding the ${SIZING_LIMITS.acLines}-line sizing limit — split into smaller, single-purpose PRDs.`,
    );
  }

  if (acLines.some((line) => line.length > SIZING_LIMITS.acLineChars)) {
    warnings.push(
      `One or more acceptance criteria lines exceed ${SIZING_LIMITS.acLineChars} characters — break the line up into smaller, single-purpose criteria.`,
    );
  }

  if (acLines.some((line) => OPEN_ENDED_RE.test(line))) {
    warnings.push(
      'One or more acceptance criteria lines describe an open-ended search-and-fix task (e.g. "grep ... and update ...") — scope it to a concrete, bounded change instead.',
    );
  }

  if (acLines.some((line) => {
    const matches = line.match(TIMEOUT_CMD_RE);
    return matches && matches.length >= 2;
  })) {
    warnings.push(
      'One or more acceptance criteria lines run two or more `timeout <n>` commands — split into separate criteria, one command each.',
    );
  }

  const bodyChars = String(goal || '').length
    + String(implementationNotes || '').length
    + acLines.join('\n').length;
  if (bodyChars > SIZING_LIMITS.bodyChars) {
    warnings.push(
      `Combined goal + implementation notes + acceptance criteria is ${bodyChars} characters, exceeding the ${SIZING_LIMITS.bodyChars}-character sizing limit — split into smaller PRDs.`,
    );
  }

  return warnings;
}

module.exports = { SIZING_LIMITS, sizingWarnings };
