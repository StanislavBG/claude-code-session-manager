/**
 * auditLog.cjs — append-only trace of every Epic/PRD creation, so a rogue or
 * unexpected Epic/PRD can always be traced back to its origin.
 *
 * Deliberately machine-level (~/.claude/session-manager/), not under any
 * project's session-manager-operations/ — this is a security trace, not app
 * state a project's single-writer law needs to arbitrate, and it must
 * survive even if the project's ops root doesn't exist yet.
 *
 * Best-effort only: a logging failure must never block the mint/create it is
 * observing (same posture as rcaReport.cjs / dodDrainHook.cjs).
 *
 * Plain Node module (no Electron deps) so scripts/mint-epic.cjs and
 * scripts/mint-epic.cjs (which runs outside Electron) can require it too.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { auditLogPath } = require('./schedulerPaths.cjs');

/**
 * Best-effort identity of the process making this call — there is no
 * cryptographic caller identity available across the admin HTTP API (bearer
 * token proves "runs as this OS user", not "which agent/session"), so this
 * captures every breadcrumb that IS available: this process's pid/ppid, and
 * (when set) the claude session id chatRunner.cjs stamps on headless
 * `claude -p` children and passes down to MCP server children.
 */
function callerContext() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    claudeSessionId: process.env.SM_CHAT_SESSION_ID || null,
  };
}

/**
 * appendAuditEvent(kind, fields) — append one JSONL record. `kind` is a short
 * label ('epic_mint' | 'prd_create' | ...); `fields` is event-specific detail
 * (cwd, epicId, status, title, slug, etc). Never throws.
 */
function appendAuditEvent(kind, fields = {}) {
  try {
    const record = {
      at: new Date().toISOString(),
      kind,
      ...fields,
      caller: callerContext(),
    };
    const target = auditLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(record)}\n`);
  } catch (e) {
    console.error('[auditLog] failed to append audit event', e?.message ?? String(e));
  }
}

module.exports = { appendAuditEvent, auditLogPath };
