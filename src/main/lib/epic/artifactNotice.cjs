// @ts-check
/**
 * artifactNotice.cjs — when files land in an Epic's Artifacts store, append ONE
 * PromptSession 'response' event (notice 'artifact-ready') listing what landed, so the
 * owner sees it in the Epic chat. One notice per publish call / ingest batch, never one
 * per file. Writes only through promptSessionEvents.appendResponseEventWithReason (the
 * same append path, and writer id, as the scheduler's 'build-done' notice).
 *
 * postArtifactReadyNotice({ cwd, epicId, entries, append? }) → Promise<{ ok, reason? }>
 *   cwd     — the project root (artifact paths are made relative to it)
 *   entries — artifactStore results: `{ storedPath, entry }` (publishArtifact / ingestDir
 *             `published[]`), or flat `{ title, kind, size, path|storedPath }` rows
 * Logs failures, never throws; empty entries or a missing epicId post nothing.
 */
'use strict';

const path = require('node:path');

const MAX_ROWS = 20;

/**
 * @param {string} cwd
 * @param {any} item
 * @returns {{ title: string, kind: string, path: string, size: number } | null}
 */
function toRow(cwd, item) {
  if (!item || typeof item !== 'object') return null;
  const e = item.entry && typeof item.entry === 'object' ? item.entry : item;
  const abs = typeof item.storedPath === 'string' ? item.storedPath : (typeof e.path === 'string' ? e.path : null);
  let rel = '';
  if (abs) {
    rel = path.isAbsolute(abs) && cwd ? path.relative(cwd, abs) : abs;
    rel = rel.split(path.sep).join('/');
  }
  const title = typeof e.title === 'string' && e.title ? e.title : (typeof e.name === 'string' ? e.name : path.basename(rel || 'artifact'));
  return {
    title,
    kind: typeof e.kind === 'string' ? e.kind : 'other',
    path: rel,
    size: typeof e.size === 'number' && Number.isFinite(e.size) ? e.size : 0,
  };
}

/**
 * @param {{ cwd?: string, epicId?: string | null, entries?: any[], append?: Function }} [args]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function postArtifactReadyNotice({ cwd, epicId, entries, append } = {}) {
  try {
    if (!cwd || typeof epicId !== 'string' || !epicId) return { ok: false, reason: 'missing-args' };
    const rows = (Array.isArray(entries) ? entries : [])
      .map((it) => toRow(cwd, it))
      .filter((r) => r !== null);
    if (rows.length === 0) return { ok: false, reason: 'empty' };
    const text = rows.length === 1 ? `Artifact ready: ${rows[0].title}` : `${rows.length} artifacts ready`;
    /** @type {{ notice: string, artifacts: object[], moreCount?: number }} */
    const meta = { notice: 'artifact-ready', artifacts: rows.slice(0, MAX_ROWS) };
    if (rows.length > MAX_ROWS) meta.moreCount = rows.length - MAX_ROWS;
    const fn = append || require('../../promptSessionEvents.cjs').appendResponseEventWithReason;
    const res = await fn(cwd, epicId, text, meta);
    if (res && res.ok === false) {
      console.warn(`[artifactNotice] artifact-ready notice not posted for ${epicId}: ${res.reason || 'refused'}`);
      return { ok: false, reason: res.reason || 'refused' };
    }
    return { ok: true };
  } catch (e) {
    console.error('[artifactNotice] artifact-ready notice failed', epicId, e instanceof Error ? e.message : e);
    return { ok: false, reason: 'error' };
  }
}

module.exports = { postArtifactReadyNotice, MAX_ROWS };
