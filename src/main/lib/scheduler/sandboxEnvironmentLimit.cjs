'use strict';

/**
 * Pure classifier: did the OS job sandbox itself refuse something the job
 * tried? Such a failure is an environment limit, not a code defect — an
 * auto-fix investigation runs in the same sandbox and hits the same wall
 * (Self 1313 -> 1313-fix). Deliberately narrow: each pattern needs the
 * sandbox-specific symptom AND its object on one line, so an ordinary EACCES
 * in user code or the bare word "sandbox" never matches.
 */

const PATTERNS = [
  ['claude-dir-write', /sandbox[^\n]{0,80}\.claude/i],
  ['unix-socket', /(?:Operation not permitted)[^\n]{0,80}AF_UNIX|AF_UNIX[^\n]{0,80}Operation not permitted/i],
  ['readonly-tmp', /(?:Errno 30|Read-only file system)[^\n]{0,80}\/tmp|\/tmp[^\n]{0,80}(?:Errno 30|Read-only file system)/i],
];

const ENVIRONMENT_LIMIT_MESSAGE =
  'environment limit (job sandbox), not a code bug — see PRD_AUTHORING.md#job-sandbox-limits';

/** @returns {null | { kind: 'claude-dir-write'|'unix-socket'|'readonly-tmp', evidence: string }} */
function detectSandboxEnvironmentLimit(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) return { kind, evidence: m[0].slice(0, 200) };
  }
  return null;
}

module.exports = { detectSandboxEnvironmentLimit, ENVIRONMENT_LIMIT_MESSAGE };
