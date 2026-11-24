'use strict';

/**
 * voicesIpc.cjs — the Voices screen's IPC (Project Home ▸ Video ▸ Voices).
 * Renderer IPC only: no admin HTTP route or MCP tool reaches the writers here,
 * so changing an approved voice always takes a human click in the app.
 *
 *   voices:list      {cwd}                 -> { voices, errors, lane }
 *                     each voice = voiceLibrary.listVoices entry + lastPreview
 *                     {at, wallMs, audioSeconds} | null (newest 'preview' usage
 *                     line for this project, voiceLane.readUsage) + inLane
 *                     {lane, position} | null (voiceLane.laneSnapshot).
 *   voices:preview   {cwd, voiceId, text}  -> previewVoice result, bytes as a Uint8Array.
 *   voices:approve   {cwd, voiceId}        -> writes <voicesHome>/approvals.json
 *                     each approval as {pin, approvedAt (ISO)}, pin = voiceLibrary.pinOf;
 *                     project/machine voices only.
 *   voices:unapprove {cwd, voiceId}        -> removes that approval.
 *   voices:delete    {cwd, voiceId}        -> deletes the effective project or
 *                     machine voice file; refuses an approved voice and a built-in.
 *
 * This module is the ONLY writer of approvals.json and of voice deletions
 * (voiceLibrary.cjs only reads approvals). Approval keys come from
 * voiceLibrary.approvalKey — the reader's own function, never a copy.
 *
 * deps: { schemas, validatePath } plus optional test overrides
 *       { resolveProjectRoot, voiceLibrary, voiceLane, previewVoice, now }.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomicSync } = require('../util/atomicFs.cjs');

const BUILTIN_ERROR = 'built-in voices cannot be approved, unapproved or deleted';
const APPROVED_DELETE_ERROR = 'this voice is approved — unapprove it first';

function libOf(deps) {
  return deps.voiceLibrary || require('../demo-video-kit/voiceLibrary.cjs');
}
function laneOf(deps) {
  return deps.voiceLane || require('../demo-video-kit/voiceLane.cjs');
}

/** cwd -> validated, resolved project root. Throws on an invalid cwd. */
function projectRootOf(deps, cwd) {
  const real = deps.validatePath(cwd);
  const resolve = deps.resolveProjectRoot || require('../opsOwnership.cjs').resolveProjectRoot;
  return path.resolve(resolve(real));
}

// The one approval-key format, shared with the reader so the two can never drift.
const { approvalKey } = require('../demo-video-kit/voiceLibrary.cjs');

function approvalsPath(lib) {
  return path.join(lib.voicesHome(), 'approvals.json');
}

/** The effective (highest-scope) library entry for id, or null. */
function effectiveEntry(lib, root, voiceId) {
  const { voices } = lib.listVoices(root);
  return voices.find((v) => v.id === voiceId) || null;
}

function writeApprovals(lib, approvals) {
  writeJsonAtomicSync(approvalsPath(lib), { version: 1, approvals });
}

function listWithStats(deps, root) {
  const lib = libOf(deps);
  const lane = laneOf(deps);
  const { voices, errors } = lib.listVoices(root);
  let usage = [];
  try { usage = lane.readUsage({ projectRoot: root, limit: Infinity }) || []; } catch { usage = []; }
  /** @type {Map<string, any>} */
  const last = new Map();
  for (const row of usage) {
    if (!row || row.kind !== 'preview' || typeof row.voiceId !== 'string' || last.has(row.voiceId)) continue;
    last.set(row.voiceId, {
      at: typeof row.at === 'string' ? row.at : null,
      wallMs: Number.isFinite(row.wallMs) ? row.wallMs : null,
      audioSeconds: Number.isFinite(row.audioSeconds) ? row.audioSeconds : null,
    });
  }
  let snapshot = {};
  try { snapshot = lane.laneSnapshot() || {}; } catch { snapshot = {}; }
  /** @type {Map<string, {lane: string, position: number}>} */
  const inLane = new Map();
  for (const [name, tickets] of Object.entries(snapshot)) {
    for (const t of Array.isArray(tickets) ? tickets : []) {
      if (!t || typeof t.voiceId !== 'string' || inLane.has(t.voiceId)) continue;
      if (t.projectRoot && t.projectRoot !== root) continue;
      inLane.set(t.voiceId, { lane: name, position: t.position });
    }
  }
  return {
    voices: voices.map((v) => ({ ...v, lastPreview: last.get(v.id) || null, inLane: inLane.get(v.id) || null })),
    errors,
    lane: snapshot,
  };
}

async function preview(deps, root, voiceId, text) {
  const run = deps.previewVoice || require('./voicePreview.cjs').previewVoice;
  const r = await run({ projectRoot: root, voiceId, text });
  if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || 'voice preview failed' };
  return { ok: true, cached: !!r.cached, wavPath: r.wavPath, bytes: new Uint8Array(r.bytes) };
}

function approve(deps, root, voiceId) {
  const lib = libOf(deps);
  const entry = effectiveEntry(lib, root, voiceId);
  if (!entry) return { ok: false, error: `unknown voice '${voiceId}'` };
  if (entry.scope === 'builtin') return { ok: false, error: BUILTIN_ERROR };
  if (entry.scope !== 'project' && entry.scope !== 'machine') return { ok: false, error: `voice '${voiceId}' has no approvable scope` };
  const { approvals } = lib.readApprovals();
  const key = approvalKey(entry.scope, root, voiceId);
  const pin = lib.pinOf(entry, root);
  const approvedAt = (deps.now ? deps.now() : new Date()).toISOString();
  writeApprovals(lib, { ...approvals, [key]: { pin, approvedAt } });
  return { ok: true, voiceId, scope: entry.scope, pin, approvedAt };
}

function unapprove(deps, root, voiceId) {
  const lib = libOf(deps);
  const entry = effectiveEntry(lib, root, voiceId);
  if (entry && entry.scope === 'builtin') return { ok: false, error: BUILTIN_ERROR };
  const { approvals } = lib.readApprovals();
  // The effective entry's key; with no file left (removed outside the app), any
  // project/machine approval of this id so the human can clear the refusal.
  const keys = entry
    ? [approvalKey(entry.scope, root, voiceId)]
    : [approvalKey('project', root, voiceId), approvalKey('machine', root, voiceId)];
  const present = keys.filter((k) => Object.prototype.hasOwnProperty.call(approvals, k));
  if (!present.length) return { ok: false, error: `voice '${voiceId}' is not approved` };
  const next = { ...approvals };
  for (const k of present) delete next[k];
  writeApprovals(lib, next);
  return { ok: true, voiceId };
}

function deleteVoice(deps, root, voiceId) {
  const lib = libOf(deps);
  const entry = effectiveEntry(lib, root, voiceId);
  if (!entry) return { ok: false, error: `unknown voice '${voiceId}'` };
  if (entry.scope === 'builtin') return { ok: false, error: BUILTIN_ERROR };
  const { approvals } = lib.readApprovals();
  if (Object.prototype.hasOwnProperty.call(approvals, approvalKey(entry.scope, root, voiceId))) {
    return { ok: false, error: APPROVED_DELETE_ERROR };
  }
  if (typeof entry.file !== 'string' || !entry.file) return { ok: false, error: `voice '${voiceId}' has no file` };
  try {
    fs.unlinkSync(entry.file);
  } catch (e) {
    return { ok: false, error: `could not delete voice '${voiceId}': ${e && e.message ? e.message : String(e)}` };
  }
  return { ok: true, voiceId, scope: entry.scope, file: entry.file };
}

function registerVoicesIpc(ipcMain, deps = {}) {
  ipcMain.handle('voices:list', async (_event, raw) => {
    const p = deps.schemas.voicesList.parse(raw);
    return listWithStats(deps, projectRootOf(deps, p.cwd));
  });
  ipcMain.handle('voices:preview', async (_event, raw) => {
    const p = deps.schemas.voicesPreview.parse(raw);
    return preview(deps, projectRootOf(deps, p.cwd), p.voiceId, p.text);
  });
  ipcMain.handle('voices:approve', async (_event, raw) => {
    const p = deps.schemas.voicesApprove.parse(raw);
    return approve(deps, projectRootOf(deps, p.cwd), p.voiceId);
  });
  ipcMain.handle('voices:unapprove', async (_event, raw) => {
    const p = deps.schemas.voicesUnapprove.parse(raw);
    return unapprove(deps, projectRootOf(deps, p.cwd), p.voiceId);
  });
  ipcMain.handle('voices:delete', async (_event, raw) => {
    const p = deps.schemas.voicesDelete.parse(raw);
    return deleteVoice(deps, projectRootOf(deps, p.cwd), p.voiceId);
  });
}

module.exports = {
  registerVoicesIpc,
  BUILTIN_ERROR,
  APPROVED_DELETE_ERROR,
  CHANNELS: Object.freeze(['voices:list', 'voices:preview', 'voices:approve', 'voices:unapprove', 'voices:delete']),
};
