'use strict';
// Demo-video kit voice lane: a cross-process FIFO so at most one heavy voice
// synthesis (and, separately, one light one) runs machine-wide at a time.
//
//   <lane dir>/<heavy|light>/<15-digit epoch ms>-<pid>-<6 hex>.json
//
// lane dir = SM_VOICE_LANE_DIR, else <voices home>/lane, where voices home =
// SM_VOICES_HOME or ~/.claude/session-manager/voices. Order and liveness come
// from the FILE NAME (ts, pid) only, so a reader never depends on a half-written
// body; the body {voiceId,label,projectRoot,kind,since} is informational.
// Position 0 = holder. Tickets whose pid is dead or older than 6 h are swept.
// Every leaveLane appends one usage line to <voices home>/usage.jsonl.
//
// Kit files are seeded to ~/.claude/session-manager/demo-video-kit/ and must
// load standalone: node built-ins only (no ../util/atomicFs.cjs, no
// ../process/pidAlive.cjs), hence the local exclusive-create + pid check.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { voicesHome } = require('./voiceLibrary.cjs');

const LANES = Object.freeze(['heavy', 'light']);
const STALE_MS = 6 * 60 * 60 * 1000;
const USAGE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_POLL_MS = 500;
let lastTs = 0;
const TICKET_RE = /^(\d{15})-(\d+)-([0-9a-f]{6})\.json$/;

function laneDir() {
  return process.env.SM_VOICE_LANE_DIR || path.join(voicesHome(), 'lane');
}

function usagePath() {
  return path.join(voicesHome(), 'usage.jsonl');
}

function checkLane(name) {
  if (!LANES.includes(name)) throw new Error(`voiceLane: unknown lane ${JSON.stringify(name)} (heavy|light)`);
  return name;
}

/** entry.heavy (boolean) wins; else kokoro voices are light, every other engine heavy. */
function laneFor(voice, entry) {
  if (entry && typeof entry.heavy === 'boolean') return entry.heavy ? 'heavy' : 'light';
  return voice && voice.engine === 'kokoro' ? 'light' : 'heavy';
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return !!err && err.code === 'EPERM'; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

/**
 * Join a lane. opts: {lane?, voice?, entry?, voiceId, label, projectRoot, kind}.
 * lane defaults to laneFor(voice, entry). Returns the ticket handle.
 */
function enterLane(opts = {}) {
  const lane = checkLane(opts.lane || laneFor(opts.voice, opts.entry));
  const dir = path.join(laneDir(), lane);
  fs.mkdirSync(dir, { recursive: true });
  const voiceId = opts.voiceId != null ? String(opts.voiceId) : (opts.voice && opts.voice.id ? String(opts.voice.id) : null);
  const label = opts.label != null ? String(opts.label) : (opts.voice && opts.voice.label ? String(opts.voice.label) : voiceId);
  const projectRoot = opts.projectRoot != null ? String(opts.projectRoot) : null;
  const kind = opts.kind != null ? String(opts.kind) : null;
  for (let attempt = 0; ; attempt++) {
    // Strictly increasing per process, so two entries from one process keep FIFO
    // order even within the same millisecond (the 6-hex suffix is random).
    const ts = Math.max(Date.now(), lastTs + 1);
    lastTs = ts;
    const name = `${String(ts).padStart(15, '0')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`;
    const file = path.join(dir, name);
    const since = new Date(ts).toISOString();
    try {
      fs.writeFileSync(file, JSON.stringify({ voiceId, label, projectRoot, kind, since }), { flag: 'wx' });
      return { lane, name, file, ts, pid: process.pid, voiceId, label, projectRoot, kind, since, enteredAt: ts, grantedAt: null };
    } catch (err) {
      if (err && err.code === 'EEXIST' && attempt < 5) continue;
      throw err;
    }
  }
}

function readBody(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

/** Live tickets of one lane in FIFO order, sweeping dead/stale ones (never `keepName`). */
function liveTickets(lane, keepName) {
  const dir = path.join(laneDir(), lane);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const now = Date.now();
  const live = [];
  for (const name of names) {
    const m = TICKET_RE.exec(name);
    if (!m) continue;
    const ts = Number(m[1]);
    const pid = Number(m[2]);
    if (name !== keepName && (now - ts > STALE_MS || !pidAlive(pid))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* another reader swept it */ }
      continue;
    }
    live.push({ name, ts, pid, file: path.join(dir, name) });
  }
  live.sort((a, b) => (a.ts - b.ts) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return live;
}

/** {position, total, ahead:[{voiceId,label,since}]}; position 0 = holder, -1 = ticket gone. */
function lanePosition(ticket) {
  const lane = checkLane(ticket.lane);
  const live = liveTickets(lane, ticket.name);
  const idx = live.findIndex((t) => t.name === ticket.name);
  if (idx < 0) return { position: -1, total: live.length, ahead: [] };
  const ahead = live.slice(0, idx).map((t) => {
    const b = readBody(t.file);
    return { voiceId: b.voiceId ?? null, label: b.label ?? null, since: b.since ?? new Date(t.ts).toISOString() };
  });
  return { position: idx, total: live.length, ahead };
}

/**
 * Block synchronously until the ticket holds the lane. timeoutMs is required.
 * onPosition(pos) fires on every position change. On timeout the ticket leaves
 * the lane (no usage line) and {ok:false,error} names the last position.
 */
function waitTurn(ticket, { timeoutMs, pollMs = DEFAULT_POLL_MS, onPosition } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('voiceLane.waitTurn: timeoutMs is required (no unbounded wait)');
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const pos = lanePosition(ticket);
    if (pos.position === -1) {
      return { ok: false, error: `voice lane ${ticket.lane}: ticket ${ticket.name} disappeared while waiting`, position: -1 };
    }
    if (last === null || pos.position !== last) {
      last = pos.position;
      if (typeof onPosition === 'function') { try { onPosition(pos); } catch { /* caller's callback */ } }
    }
    if (pos.position === 0) {
      ticket.grantedAt = Date.now();
      return { ok: true, position: 0, waitedMs: ticket.grantedAt - ticket.enteredAt };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      leaveLane(ticket, { ok: false, record: false });
      return { ok: false, error: `voice lane ${ticket.lane}: timed out after ${timeoutMs} ms at position ${pos.position} of ${pos.total}`, position: pos.position };
    }
    sleepSync(Math.min(pollMs, left));
  }
}

function appendUsage(line) {
  const p = usagePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    if (fs.statSync(p).size > USAGE_MAX_BYTES) fs.renameSync(p, path.join(path.dirname(p), 'usage.1.jsonl'));
  } catch { /* no usage file yet */ }
  fs.appendFileSync(p, JSON.stringify(line) + '\n');
}

/**
 * Remove the ticket and (unless record:false) append one usage line
 * {at,voiceId,projectRoot,lane,kind,ok,audioSeconds,wallMs,waitedMs}.
 */
function leaveLane(ticket, { ok = true, audioSeconds = null, record = true } = {}) {
  try { fs.unlinkSync(ticket.file); } catch { /* already swept */ }
  if (!record) return null;
  const now = Date.now();
  const granted = ticket.grantedAt || ticket.enteredAt;
  const line = {
    at: new Date(now).toISOString(),
    voiceId: ticket.voiceId ?? null,
    projectRoot: ticket.projectRoot ?? null,
    lane: ticket.lane,
    kind: ticket.kind ?? null,
    ok: !!ok,
    audioSeconds: Number.isFinite(audioSeconds) ? audioSeconds : null,
    wallMs: now - granted,
    waitedMs: granted - ticket.enteredAt,
  };
  try { appendUsage(line); } catch { /* usage is best-effort; never fail a synthesis */ }
  return line;
}

/** {heavy:[...], light:[...]} each {voiceId,label,projectRoot,pid,since,position}. */
function laneSnapshot() {
  const out = {};
  for (const lane of LANES) {
    out[lane] = liveTickets(lane, null).map((t, position) => {
      const b = readBody(t.file);
      return { voiceId: b.voiceId ?? null, label: b.label ?? null, projectRoot: b.projectRoot ?? null, pid: t.pid, since: b.since ?? new Date(t.ts).toISOString(), position };
    });
  }
  return out;
}

function readLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { const j = JSON.parse(raw); if (j && typeof j === 'object') out.push(j); } catch { /* skip */ }
  }
  return out;
}

/** Usage lines for one project (all when projectRoot omitted), newest first. */
function readUsage({ projectRoot, limit = 100 } = {}) {
  const p = usagePath();
  const all = [...readLines(path.join(path.dirname(p), 'usage.1.jsonl')), ...readLines(p)];
  const rows = projectRoot == null ? all : all.filter((r) => r.projectRoot === projectRoot);
  rows.reverse();
  return Number.isFinite(limit) && limit >= 0 ? rows.slice(0, limit) : rows;
}

module.exports = {
  laneFor,
  enterLane,
  lanePosition,
  waitTurn,
  leaveLane,
  laneSnapshot,
  readUsage,
  laneDir,
  voicesHome,
  LANES,
};
