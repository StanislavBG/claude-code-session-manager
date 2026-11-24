'use strict';

/**
 * voiceAdminRoutes.cjs — the voice library's READ routes for agents (MCP
 * voice_list / voice_preview). Neither route can change a voice: approving,
 * unapproving and deleting stay renderer-IPC only (voicesIpc.cjs).
 *
 *   GET  /admin/voices?cwd=<abs>          -> {ok, voices, errors}  (voiceLibrary.listVoices)
 *   POST /admin/voices/preview {cwd, voiceId, text}
 *        -> {ok:true, status:'ready', cached, wavPath, wallMs, audioSeconds}
 *           when previewVoice finishes within WAIT_MS (60 s), else
 *        -> {ok:true, status:'queued', lane, position}
 *           while the run keeps going in-process. A repeat call with the same
 *           (project, voiceId, text) joins that run, or — once it finished —
 *           previewVoice answers from its clip cache.
 *
 * cwd goes through projectHomeAdminRoutes.resolveCwd (the shared project-root
 * resolver + allowed-roots check); voiceId must match VOICE_ID_RE and text be
 * 1-TEXT_MAX chars after trimming; bad input answers 400.
 *
 * deps (tests): { resolveCwd, voiceLibrary, voiceLane, previewVoice, waitMs, now }.
 */

const { readBody, sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { wavSeconds } = require('../demo-video-kit/character.cjs');

const VOICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TEXT_MAX = 300;
const WAIT_MS = 60 * 1000;
const BODY_MAX = 64 * 1024;

/** key -> {promise, startedAt} for previews still running in-process. */
const pending = new Map();

function depsOf(deps) {
  return {
    resolveCwd: deps.resolveCwd || require('../feedback-remote/projectHomeAdminRoutes.cjs').resolveCwd,
    voiceLibrary: deps.voiceLibrary || require('../demo-video-kit/voiceLibrary.cjs'),
    voiceLane: deps.voiceLane || require('../demo-video-kit/voiceLane.cjs'),
    previewVoice: deps.previewVoice || require('./voicePreview.cjs').previewVoice,
    waitMs: Number.isFinite(deps.waitMs) && deps.waitMs >= 0 ? deps.waitMs : WAIT_MS,
    now: deps.now || Date.now,
  };
}

/** Seconds of audio in the clip at wavPath (character.cjs wavSeconds, 3 dp), else null. */
function clipSeconds(wavPath) {
  if (!wavPath) return null;
  const s = wavSeconds(wavPath);
  return s > 0 ? Math.round(s * 1000) / 1000 : null;
}

/** -> null when the preview body is acceptable, else the 400 reason. */
function validatePreviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid payload';
  if (typeof body.voiceId !== 'string' || !VOICE_ID_RE.test(body.voiceId)) {
    return 'voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/';
  }
  const t = typeof body.text === 'string' ? body.text.trim() : '';
  if (t.length < 1 || t.length > TEXT_MAX) return `text must be 1-${TEXT_MAX} chars`;
  return null;
}

/** This preview's place in the voice lane: {lane, position} or {lane:null, position:null}. */
function lanePositionOf(d, root, voiceId) {
  let snapshot = {};
  try { snapshot = d.voiceLane.laneSnapshot() || {}; } catch { snapshot = {}; }
  for (const [lane, tickets] of Object.entries(snapshot)) {
    for (const t of Array.isArray(tickets) ? tickets : []) {
      if (!t || t.voiceId !== voiceId) continue;
      if (t.projectRoot && t.projectRoot !== root) continue;
      return { lane, position: Number.isFinite(t.position) ? t.position : null };
    }
  }
  return { lane: null, position: null };
}

function listHandler(deps) {
  return async (_req, res, query) => {
    const d = depsOf(deps);
    const resolved = d.resolveCwd(query?.get('cwd') ?? '');
    if (!resolved.ok) {
      sendJson(res, resolved.status || 400, { ok: false, error: resolved.error });
      return;
    }
    const { voices, errors } = d.voiceLibrary.listVoices(resolved.cwd);
    sendJson(res, 200, { ok: true, voices, errors });
  };
}

function previewHandler(deps) {
  return async (req, res) => {
    const d = depsOf(deps);
    let raw;
    try {
      raw = await readBody(req, BODY_MAX);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'}` });
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    const invalid = validatePreviewBody(body);
    if (invalid) {
      sendJson(res, 400, { ok: false, error: invalid });
      return;
    }
    const resolved = d.resolveCwd(body.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status || 400, { ok: false, error: resolved.error });
      return;
    }
    const root = resolved.cwd;
    const voiceId = body.voiceId;
    const text = body.text.trim();
    const rv = d.voiceLibrary.resolveVoiceId(root, voiceId);
    if (!rv || !rv.ok) {
      sendJson(res, 400, { ok: false, error: (rv && rv.error) || `unknown voice '${voiceId}'` });
      return;
    }

    const key = JSON.stringify([root, voiceId, text]);
    let run = pending.get(key);
    if (!run) {
      const startedAt = d.now();
      const promise = Promise.resolve()
        .then(() => d.previewVoice({ projectRoot: root, voiceId, text }))
        .catch((e) => ({ ok: false, error: `voice preview failed: ${e?.message ?? String(e)}` }))
        .then((r) => ({ r, endedAt: d.now() }))
        .finally(() => { if (pending.get(key) === run) pending.delete(key); });
      run = { promise, startedAt };
      pending.set(key, run);
    }

    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), d.waitMs); });
    const outcome = await Promise.race([run.promise, timeout]);
    clearTimeout(timer);

    if (!outcome) {
      sendJson(res, 200, { ok: true, status: 'queued', ...lanePositionOf(d, root, voiceId) });
      return;
    }
    const { r, endedAt } = outcome;
    if (!r || r.ok !== true) {
      sendJson(res, 500, { ok: false, error: (r && r.error) || 'voice preview failed' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      status: 'ready',
      cached: !!r.cached,
      wavPath: r.wavPath,
      wallMs: Math.max(0, endedAt - run.startedAt),
      audioSeconds: clipSeconds(r.wavPath),
    });
  };
}

function registerAdminRoute(adminHttp, deps = {}) {
  adminHttp.registerRoute('GET', '/admin/voices', listHandler(deps));
  adminHttp.registerRoute('POST', '/admin/voices/preview', previewHandler(deps));
}

/** Tests only: forget previews still tracked in-process. */
function _resetPending() {
  pending.clear();
}

module.exports = { registerAdminRoute, validatePreviewBody, VOICE_ID_RE, TEXT_MAX, WAIT_MS, _resetPending };
