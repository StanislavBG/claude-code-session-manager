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
  ['claude-dir-write', /sandbox[^\n]{0,80}\.claude|(?:Operation not permitted|Permission denied)[^\n]{0,160}\.claude\/|\.claude\/[^\n]{0,160}(?:Operation not permitted|Permission denied)/i],
  ['unix-socket', /(?:Operation not permitted)[^\n]{0,80}AF_UNIX|AF_UNIX[^\n]{0,80}Operation not permitted/i],
  ['readonly-tmp', /(?:Errno 30|Read-only file system)[^\n]{0,80}\/tmp|\/tmp[^\n]{0,80}(?:Errno 30|Read-only file system)/i],
];

const WINDOW_LINES = 3;
const WINDOWED_KINDS = new Set(['unix-socket', 'readonly-tmp']);

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

/** Run the per-line matcher over each decoded physical line of `text`. */
function detectPerLine(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const hit = detectSandboxEnvironmentLimit(line);
    if (hit) return hit;
  }
  // Python tracebacks split the call and the errno over adjacent lines.
  for (let i = 0; i + 1 < lines.length; i++) {
    const win = lines.slice(i, i + WINDOW_LINES).join(' ');
    for (const [kind, re] of PATTERNS) {
      if (!WINDOWED_KINDS.has(kind)) continue;
      const m = re.exec(win);
      if (m) return { kind, evidence: m[0].slice(0, 200) };
    }
  }
  return null;
}

/**
 * Detect a sandbox refusal in a stream-json log tail. Only text the sandbox
 * itself produced is considered: decoded Bash tool_result content, and the
 * executor's `SCHEDULER_VERDICT: FAIL <reason>` from the final result text.
 * Text a job merely read (Read tool_result) or quoted (assistant text) is ignored.
 * @param {string} text
 * @returns {null | { kind: 'claude-dir-write'|'unix-socket'|'readonly-tmp', evidence: string }}
 */
function sandboxLimitFromStreamJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const bashIds = new Set();
  let hit = null;
  let resultText = null;
  let structuredOutput;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'result' && typeof ev.result === 'string') {
      resultText = ev.result;
      const so = ev.structured_output ?? ev.structuredOutput;
      if (so && typeof so === 'object' && !Array.isArray(so)) structuredOutput = so;
      continue;
    }
    const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : null;
    if (!content) continue;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (ev.type === 'assistant' && item.type === 'tool_use' && item.name === 'Bash' && item.id) {
        bashIds.add(item.id);
      } else if (ev.type === 'user' && item.type === 'tool_result' && bashIds.has(item.tool_use_id)) {
        if (hit || item.is_error !== true) continue;
        const body = typeof item.content === 'string'
          ? item.content
          : Array.isArray(item.content)
            ? item.content.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('')
            : '';
        hit = detectPerLine(body);
      }
    }
  }
  if (hit) return hit;
  if (resultText || structuredOutput) {
    // Lazy require: runVerify.cjs is large.
    const { scanSentinelReason } = require('../../runVerify.cjs');
    return detectPerLine(scanSentinelReason({ resultText, ...(structuredOutput ? { structuredOutput } : {}) }, []));
  }
  return null;
}

/**
 * Finalize stamp/clear decision for a job row.
 * @returns {{ environmentLimit: object|null, error: string|null }}
 */
function environmentLimitStamp(sandboxLimit, status) {
  if (sandboxLimit && (status === 'failed' || status === 'needs_review')) {
    return { environmentLimit: sandboxLimit, error: ENVIRONMENT_LIMIT_MESSAGE };
  }
  return { environmentLimit: null, error: null };
}

module.exports = { detectSandboxEnvironmentLimit, sandboxLimitFromStreamJson, environmentLimitStamp, ENVIRONMENT_LIMIT_MESSAGE };
