/**
 * prdSandboxWarnings.cjs — pure advisory rule: a PRD that lists a path under `.claude/` in its
 * files AND mentions `git mv` / `git rm` / `rm` in its goal, notes or criteria will park, because
 * job Bash cannot write under `.claude/` in the sandbox (Self PRD 1326). Never blocks a write.
 */
'use strict';

const VERB_RE = /\bgit\s+(mv|rm)\b|(^|[\s`'"(;&|])rm(?=$|[\s.,;:)`'"])/m;

/** @param {unknown} p */
function isClaudePath(p) {
  return typeof p === 'string' && p.split('/').some((seg) => seg === '.claude');
}

/**
 * Returns `[]` or a one-element array holding the warning (spread-compatible with sizingWarnings).
 * @param {any} input createPrd()'s input shape.
 * @returns {string[]}
 */
function sandboxWarnings(input) {
  const files = Array.isArray(input?.files) ? input.files : [];
  const bad = files.filter(isClaudePath);
  if (bad.length === 0) return [];
  const ac = Array.isArray(input?.acceptanceCriteria) ? input.acceptanceCriteria : [];
  const text = [input?.goal, input?.implementationNotes, ...ac]
    .filter((s) => typeof s === 'string')
    .join('\n');
  if (!VERB_RE.test(text)) return [];
  return [
    `files lists ${bad.map((p) => `\`${p}\``).join(', ')} under .claude/ and the PRD mentions git mv / git rm / rm — Bash writes there are refused by the job sandbox, so the job will park. Use the Write/Edit tools for .claude/ changes instead. See PRD_AUTHORING.md#job-sandbox-limits.`,
  ];
}

module.exports = { sandboxWarnings };
