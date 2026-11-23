'use strict';

/**
 * epicAgentRefresh.cjs — the ONLY path by which a live persona edit reaches an existing Epic.
 *
 * An Epic minted with an agentType pins its persona as an AgentSnapshot (epicMint.cjs's
 * AGENT SNAPSHOT PIN); every later turn builds from that snapshot, so an edit to the persona
 * file reaches only NEW Epics. refreshEpicAgentSnapshot is the explicit, audited action that
 * re-snapshots the persona (same agentType + packs) and re-stamps the Epic's agentSnapshotId.
 * One audit record { kind: 'epic_agent_snapshot_updated', epicId, from, to } per change; an
 * unchanged persona (same content id) is a no-op that writes nothing.
 *
 * Electron-free at load; electron/config/ipcSchemas are required lazily in the register fn.
 */

const { activeIndexPath, readActiveIndex, writeActiveIndex, withPathLock } = require('./epicMint.cjs');
const { mirrorEpicStatus } = require('./epicStatusMirror.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');

const AUDIT_KIND = 'epic_agent_snapshot_updated';

const fail = (code, message) => ({ ok: false, code, message });

function readRow(cwd, epicId) {
  const index = readActiveIndex(cwd);
  return Object.prototype.hasOwnProperty.call(index.sessions, epicId) ? index.sessions[epicId] : null;
}

/**
 * @param {{ cwd: string, epicId: string, deps?: object }} opts
 * @returns {Promise<
 *   | { ok: true, changed: boolean, from: string|null, to: string, session: object }
 *   | { ok: false, code: string, message: string }>}
 */
async function refreshEpicAgentSnapshot({ cwd, epicId, deps = {} } = {}) {
  if (typeof cwd !== 'string' || !cwd || typeof epicId !== 'string' || !epicId) {
    return fail('invalid_args', 'cwd and epicId are required.');
  }
  const row = readRow(cwd, epicId);
  if (!row) return fail('not_found', `No open Epic ${epicId} in ${cwd}.`);
  if (!row.agentType) return fail('no_agent_type', `Epic ${epicId} has no agentType to snapshot.`);
  if (row.agentCli) return fail('not_pinnable', `Epic ${epicId} runs a non-Claude agent CLI; it loads no persona.`);

  const agentSnapshot = require('../claude/agentSnapshot.cjs');
  const build = deps.buildAgentSnapshot || agentSnapshot.buildAgentSnapshot;
  const built = await build({
    cwd,
    agentType: row.agentType,
    packs: Array.isArray(row.packs) ? row.packs : [],
    deps: deps.snapshotDeps || {},
  });
  if (built.refusal) return fail(built.refusal.code, built.refusal.detail);

  const from = typeof row.agentSnapshotId === 'string' ? row.agentSnapshotId : null;
  if (built.id === from) return { ok: true, changed: false, from, to: built.id, session: row };

  // Write-once + content-addressed: an id another Epic already pinned is a no-op write.
  const write = deps.writeAgentSnapshot || agentSnapshot.writeAgentSnapshot;
  await write(cwd, built.snapshot);

  let result;
  try {
    result = await withPathLock(activeIndexPath(cwd), async () => {
      const index = readActiveIndex(cwd);
      const current = Object.prototype.hasOwnProperty.call(index.sessions, epicId) ? index.sessions[epicId] : null;
      if (!current) return fail('not_found', `Epic ${epicId} disappeared before it could be re-stamped.`);
      const prior = typeof current.agentSnapshotId === 'string' ? current.agentSnapshotId : null;
      if (prior === built.id) return { ok: true, changed: false, from: prior, to: built.id, session: current };
      const session = { ...current, agentSnapshotId: built.id };
      index.sessions[epicId] = session;
      writeActiveIndex(cwd, index);
      mirrorEpicStatus(cwd, epicId, { session });
      return { ok: true, changed: true, from: prior, to: built.id, session };
    });
  } catch (err) {
    return fail('write_failed', `Could not re-stamp Epic ${epicId}: ${err && err.message ? err.message : err}`);
  }
  if (result.ok && result.changed) {
    appendAuditEvent(AUDIT_KIND, { cwd, epicId, from: result.from, to: result.to }, deps.auditOpts || {});
  }
  return result;
}

function registerEpicAgentRefreshHandlers() {
  const { ipcMain } = require('electron');
  const { validatePath } = require('../../config.cjs');
  const { schemas: s, validated: v } = require('../../ipcSchemas.cjs');
  ipcMain.handle(
    'epic:refresh-agent-snapshot',
    v(s.epicRefreshAgentSnapshot, ({ cwd, epicId }) => {
      validatePath(cwd);
      return refreshEpicAgentSnapshot({ cwd, epicId });
    }),
  );
}

module.exports = { refreshEpicAgentSnapshot, registerEpicAgentRefreshHandlers, AUDIT_KIND };
