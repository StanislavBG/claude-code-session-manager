'use strict';

// Same cap classifyTranscriptLine.cjs uses (MAX_RAW_STR) for raw tool_use
// content — reused here so a large Edit/Write payload can't bloat the
// in-memory ChatTurn / localStorage-persisted chat state.
const MAX_DIFF_STR = 4096;

function capStr(s) {
  if (typeof s !== 'string') return s;
  return s.length > MAX_DIFF_STR ? `${s.slice(0, MAX_DIFF_STR)}…` : s;
}

/**
 * Pull a diff payload out of an Edit/Write tool_use block's `input`.
 * Returns undefined for any other tool (including malformed Edit/Write
 * blocks missing `file_path`).
 * @param {{name: string, input?: Record<string, unknown>}} block
 * @returns {{ filePath: string, oldText?: string, newText?: string } | undefined}
 */
function extractDiff(block) {
  const input = block?.input;
  if (!input || typeof input !== 'object' || typeof input.file_path !== 'string') return undefined;
  if (block.name === 'Edit') {
    return {
      filePath: input.file_path,
      oldText: capStr(input.old_string),
      newText: capStr(input.new_string),
    };
  }
  if (block.name === 'Write') {
    return {
      filePath: input.file_path,
      newText: capStr(input.content),
    };
  }
  return undefined;
}

/**
 * Classify a single stream-json tool_use block into a UI-facing kind.
 * O(1) — no loops, pure string/prefix checks.
 * @param {{name: string, input?: Record<string, unknown>}} block
 * @returns {{ kind: 'skill' | 'mcp' | 'tool', label: string, diff?: { filePath: string, oldText?: string, newText?: string } }}
 */
function classifyToolUse(block) {
  if (block.name === 'Skill') {
    return { kind: 'skill', label: block.input?.skill ?? 'skill' };
  }
  if (block.name.startsWith('mcp__')) {
    return { kind: 'mcp', label: block.name.replace(/^mcp__/, '') };
  }
  const diff = extractDiff(block);
  return diff ? { kind: 'tool', label: block.name, diff } : { kind: 'tool', label: block.name };
}

module.exports = { classifyToolUse, extractDiff, MAX_DIFF_STR };

// ─── Epic event log summaries (job.tool_use / human.message) ────────────────
// Events carry summaries only — never a tool's full input or output.
const EVENT_SUMMARY_MAX = 200;

// Secret-shaped values: KEY=value / "key": "value" pairs whose key names a
// secret, bearer tokens, and well-known token prefixes.
const SECRET_ASSIGN_RE = /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abposr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g;

/** Replace secret-shaped values with [redacted]. */
function redactSecrets(s) {
  if (typeof s !== 'string') return '';
  // Bearer first: "Authorization: Bearer <t>" would otherwise redact only "Bearer".
  return s
    .replace(BEARER_RE, (_m, scheme) => `${scheme} [redacted]`)
    .replace(SECRET_ASSIGN_RE, (m, k, sep, v) => (/^\[redacted\]$|^(?:Bearer|Basic)$/i.test(v) ? m : `${k}${sep}[redacted]`))
    .replace(TOKEN_PREFIX_RE, '[redacted]');
}

/** Collapse whitespace and cap at max chars (ellipsis counted inside the cap). */
function capSummary(s, max = EVENT_SUMMARY_MAX) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The one input field that best describes each common tool call.
const SUMMARY_FIELDS = ['file_path', 'command', 'pattern', 'path', 'url', 'query', 'skill', 'description', 'prompt', 'notebook_path'];

/**
 * A ≤200-char, secret-redacted one-line summary of a tool_use block:
 * the classified label plus its most descriptive input field. Never the
 * full input (Edit/Write bodies are never included).
 * @param {{name: string, input?: Record<string, unknown>}} block
 * @returns {string}
 */
function summarizeToolUse(block) {
  const name = typeof block?.name === 'string' ? block.name : 'tool';
  let label = name;
  try { label = classifyToolUse({ name, input: block?.input }).label || name; } catch { /* keep name */ }
  const input = block?.input && typeof block.input === 'object' ? block.input : {};
  let detail = '';
  for (const f of SUMMARY_FIELDS) {
    if (typeof input[f] === 'string' && input[f]) { detail = input[f]; break; }
  }
  // Redact before capping so a cut can never expose a partial secret.
  const redacted = redactSecrets(capSummary(detail, 4 * EVENT_SUMMARY_MAX));
  return capSummary(detail ? `${label}: ${redacted}` : String(label));
}

/**
 * The human.message payload for one human prompt: char count + ≤200-char
 * redacted excerpt.
 * @param {string} prompt
 * @returns {{ chars: number, excerpt: string }}
 */
function humanMessageSummary(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  return { chars: text.length, excerpt: capSummary(redactSecrets(capSummary(text, 4 * EVENT_SUMMARY_MAX))) };
}

/**
 * Parse complete stream-json lines from `text` (which starts at byte
 * `baseOffset` of the job log) into tool_use descriptors. Unparsable lines
 * (scheduler banner lines, torn writes) are skipped.
 * @param {string} text
 * @param {number} baseOffset
 * @returns {Array<{ tool: string, summary: string, transcriptOffset: number }>}
 */
function extractToolUses(text, baseOffset = 0) {
  const out = [];
  let offset = baseOffset;
  for (const line of String(text).split('\n')) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.includes('"tool_use"')) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.type === 'assistant' ? obj?.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      out.push({ tool: block.name, summary: summarizeToolUse(block), transcriptOffset: lineOffset });
    }
  }
  return out;
}

/**
 * Incremental tail of a job's stream-json log. poll() reads the bytes
 * written since the last poll, hands each complete line's tool_use blocks
 * to onToolUse, and keeps a partial trailing line for the next poll.
 * flush() also parses the final unterminated line. Never throws.
 * @param {{ logPath: string, onToolUse: (e: { tool: string, summary: string, transcriptOffset: number }) => void, fsImpl?: typeof import('node:fs') }} opts
 */
function createToolUseLogTailer({ logPath, onToolUse, fsImpl }) {
  const fsMod = fsImpl || require('node:fs');
  let readOffset = 0; // bytes consumed from the file
  let pending = Buffer.alloc(0); // bytes of an unterminated trailing line
  let pendingOffset = 0; // file offset where `pending` starts

  const emit = (text, base) => {
    for (const e of extractToolUses(text, base)) {
      try { onToolUse(e); } catch (err) { console.error('[toolUseTailer] onToolUse failed', err?.message ?? err); }
    }
  };

  function poll() {
    try {
      const size = fsMod.statSync(logPath).size;
      if (size <= readOffset) return;
      const len = size - readOffset;
      const buf = Buffer.alloc(len);
      const fd = fsMod.openSync(logPath, 'r');
      let n = 0;
      try { n = fsMod.readSync(fd, buf, 0, len, readOffset); } finally { fsMod.closeSync(fd); }
      readOffset += n;
      const all = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : buf.subarray(0, n);
      const lastNl = all.lastIndexOf(0x0a);
      if (lastNl === -1) { pending = Buffer.from(all); return; }
      const complete = all.subarray(0, lastNl);
      const base = pendingOffset;
      pending = Buffer.from(all.subarray(lastNl + 1));
      pendingOffset = base + lastNl + 1;
      emit(complete.toString('utf8'), base);
    } catch { /* missing/unreadable log: try again next poll */ }
  }

  function flush() {
    poll();
    if (pending.length) {
      const text = pending.toString('utf8');
      const base = pendingOffset;
      pendingOffset += pending.length;
      pending = Buffer.alloc(0);
      emit(text, base);
    }
  }

  return { poll, flush };
}

module.exports.EVENT_SUMMARY_MAX = EVENT_SUMMARY_MAX;
module.exports.redactSecrets = redactSecrets;
module.exports.summarizeToolUse = summarizeToolUse;
module.exports.humanMessageSummary = humanMessageSummary;
module.exports.extractToolUses = extractToolUses;
module.exports.createToolUseLogTailer = createToolUseLogTailer;

/**
 * Wire a job's log tailer to the Epic event log: each tool_use block of a job
 * with an epicId appends job.tool_use { slug, tool, summary, transcriptOffset }
 * through `appendEvent` (epicEventLog.appendEpicEvent). An append failure
 * (sync throw or rejection) is logged via `logError`, never thrown. Returns
 * null when the job has no epicId/cwd (nothing to emit).
 * @param {{ job: { slug?: string, epicId?: string, cwd?: string }, logPath: string, appendEvent: (cwd: string, epicId: string, event: Record<string, unknown>) => unknown, logError?: (msg: string) => void, fsImpl?: typeof import('node:fs') }} opts
 */
function createJobToolUseEmitter({ job, logPath, appendEvent, logError, fsImpl }) {
  const epicId = job && job.epicId;
  const cwd = job && job.cwd;
  if (typeof epicId !== 'string' || !epicId || typeof cwd !== 'string' || !cwd || typeof appendEvent !== 'function') return null;
  const report = (err) => {
    const msg = `[scheduler] job.tool_use append failed for ${job.slug ?? '(unknown)'}: ${err?.message ?? String(err)}`;
    try { (logError || console.error)(msg); } catch { /* logging must never be the thing that fails */ }
  };
  return createToolUseLogTailer({
    logPath,
    fsImpl,
    onToolUse: ({ tool, summary, transcriptOffset }) => {
      try {
        const p = appendEvent(cwd, epicId, { kind: 'job.tool_use', slug: job.slug ?? null, tool, summary, transcriptOffset });
        if (p && typeof (/** @type {any} */ (p)).catch === 'function') (/** @type {any} */ (p)).catch(report);
      } catch (err) {
        report(err);
      }
    },
  });
}

module.exports.createJobToolUseEmitter = createJobToolUseEmitter;
