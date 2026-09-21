'use strict';

/**
 * opsErrorLog.cjs — sole writer of the `logs` ops namespace
 * (single-writer law, see opsOwnership.cjs). Appends one structured JSONL
 * line per error to `<cwd>/session-manager-operations/logs/errors-<date>.jsonl`
 * so errors from every tab/surface land in one common, per-project place
 * instead of scattered across console.error calls and the machine-global
 * <userData>/logs/ (which mixes every project together and isn't tagged for
 * tracing). Every call site funnels through `appendError` — that is what
 * makes this the sole writer in practice, not just in the OWNERS map.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertOpsWrite } = require('./opsOwnership.cjs');
const { isEphemeralCwd } = require('./ephemeralCwd.cjs');

// Same redaction policy as logs.cjs's sanitizeMeta — kept independent (not
// shared/required) so this module has no dependency on the Electron `app`
// module and can be unit-tested without a running app.
const REDACT_KEY = /^(transcript|interim|final|text|content|partial|userText|message|token|secret|password|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  if (Array.isArray(meta)) return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = REDACT_KEY.test(k) ? '[redacted]' : v;
  }
  return out;
}

function logsDir(cwd) {
  const { opsPath } = require('./opsOwnership.cjs');
  return opsPath(cwd, 'logs');
}

function todayFile(cwd) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(logsDir(cwd), `errors-${yyyy}-${mm}-${dd}.jsonl`);
}

function writeLocalLine({ cwd, scope, level, tabId, epicId, tags, message, meta }) {
  const file = todayFile(cwd);
  try {
    assertOpsWrite(file, 'logs');
  } catch {
    return; // fail-closed, same as every other ops write path — never throw from a log call
  }

  const autoTags = [
    `level:${level}`,
    `scope:${scope || 'unknown'}`,
    ...(tabId ? [`tab:${tabId}`] : []),
    ...(epicId ? [`epic:${epicId}`] : []),
  ];
  const allTags = Array.from(new Set([...autoTags, ...tags]));

  const line = {
    ts: new Date().toISOString(),
    level,
    scope: scope || 'unknown',
    tabId: tabId || null,
    epicId: epicId || null,
    tags: allTags,
    message: String(message ?? ''),
    ...(meta !== undefined ? { meta: sanitizeMeta(meta) } : {}),
  };

  try {
    fs.mkdirSync(logsDir(cwd), { recursive: true });
    // 0o600: same rationale as logs.cjs — error meta can carry local paths /
    // device labels, keep it off other local users' reach.
    const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(line) + '\n'); } finally { fs.closeSync(fd); }
  } catch { /* best-effort — a logging failure must never break the caller */ }
  return allTags;
}

/**
 * Mirrors every appendError() line to telemetryClient — the single tap that
 * covers pty/chatRunner/scheduler/logs.cjs/renderer in one place, since they
 * all already funnel through appendError. Runs AFTER the local write and is
 * independently wrapped so a throwing telemetry stub can never prevent or
 * corrupt it. Reported regardless of the local ephemeral-cwd refusal — an
 * Epic/job worktree still has a REAL project behind it, just not one that
 * should ever have ops state materialized inside the worktree itself — so
 * `cwd` is normalized through projectRootOf() before being handed to the
 * client (which converts it to projectHash; the raw path never leaves this
 * process).
 *
 * `message` is caller-supplied free text — it can legitimately contain a
 * fragment of a chat/tool error that itself embeds a prompt, a file path, or
 * other project-identifying content (opsErrorLog is a general-purpose error
 * funnel, not a curated allowlist). It is therefore NEVER put on the wire's
 * `msg`/`name` (which only get path-level redaction upstream) — it travels
 * under a literal `message` key inside `context`/`fields`, which
 * telemetryClient's redactDeep unconditionally rewrites to `[redacted]`
 * (REDACT_KEY matches the key name, not its content). `msg`/`name` carry only
 * `scope`, a small closed vocabulary of subsystem names — structural, never
 * free text.
 */
function reportToTelemetry({ cwd, scope, level, tabId, epicId, tags, message }) {
  try {
    const telemetryClient = require('./telemetryClient.cjs');
    const { projectRootOf } = require('./activeSessions.cjs');
    const normalizedCwd = projectRootOf(cwd) || cwd;
    const autoTags = [
      `scope:${scope || 'unknown'}`,
      ...(tabId ? [`tab:${tabId}`] : []),
      ...(epicId ? [`epic:${epicId}`] : []),
    ];
    const allTags = Array.from(new Set([...autoTags, ...(tags || [])]));
    const label = `opsError:${scope || 'unknown'}`;
    const context = { scope: scope || 'unknown', tags: allTags, cwd: normalizedCwd, message };
    if (level === 'warn') {
      telemetryClient.logLine({ level: 'warn', msg: label, fields: context });
    } else {
      telemetryClient.reportError({ name: scope || 'opsError', msg: label, context });
    }
  } catch { /* telemetry must never break the caller — this is the sole error funnel */ }
}

function realOrResolved(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when `cwd` resolves inside os.tmpdir() or SM_SANDBOX_DIR. O(roots). */
function isInsideTestScratch(cwd) {
  const target = realOrResolved(cwd);
  const roots = [os.tmpdir(), process.env.SM_SANDBOX_DIR].filter(Boolean);
  return roots.some((r) => isInside(target, realOrResolved(r)));
}

/**
 * Append one structured error line, tagged for tracing/analysis.
 *
 * @param {{
 *   cwd: string,           // required — which project's ops root owns this line
 *   scope: string,         // subsystem name, e.g. 'pty', 'chatRunner', 'voice'
 *   level?: string,        // default 'error'; 'warn' also accepted
 *   tabId?: string,        // claudeSessionId of the tab this error belongs to, if any
 *   epicId?: string,       // Epic id, if this error happened inside an Epic-backed run
 *   tags?: string[],       // extra caller-supplied tags, merged with the auto-derived ones
 *   message: string,
 *   meta?: unknown,
 * }} entry
 */
function appendError({ cwd, scope, level = 'error', tabId, epicId, tags = [], message, meta }) {
  if (!cwd || typeof cwd !== 'string') return; // no project to attribute this line to — skip

  // Test-process guard: a vitest fixture passing a real project root must never
  // write to that project's logs/ NOR ship a fake event to production telemetry.
  if (process.env.VITEST && !isInsideTestScratch(cwd)) return;

  if (isEphemeralCwd(cwd)) {
    // A worktree is torn down when its Epic/job ends and os.tmpdir() is
    // scratch space either way — never materialize logs there. See
    // ephemeralCwd.cjs / queueStore.cjs's projectStateDir for the sibling
    // refusal on the scheduler namespace (verified live 2026-09-01 as a
    // recreated /tmp/session-manager-operations/logs/ tree). The telemetry
    // tap below still fires — this refusal is about the LOCAL write only.
    console.warn(`[opsErrorLog] appendError: refusing ephemeral cwd "${cwd}" (scope=${scope || 'unknown'})`);
  } else {
    writeLocalLine({ cwd, scope, level, tabId, epicId, tags, message, meta });
  }

  reportToTelemetry({ cwd, scope, level, tabId, epicId, tags, message });
}

module.exports = { appendError, logsDir, todayFile };
