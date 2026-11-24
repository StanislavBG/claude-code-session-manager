'use strict';
// Demo-video kit character: a project's mascot lives in
// <ops>/project-pages/videos/_character/{character.json,character.js}.
// Reading is plain file reading; writing goes only through the
// POST /admin/project-home/character/write route (writer 'project-home').
// speakWithCommand spawns the user's TTS argv directly — never through a shell.
// speakLines runs a {lines} (batch) voice once per speaker with a JSON manifest
// of { text, out }, and a kokoro voice once per speaker through kokoroSay.cjs, each
// with a time limit capped by SM_SCHEDULER_JOB_DEADLINE_MS. {voiceId} voices
// resolve through voiceLibrary.cjs. Every synthesis call runs inside the kit
// voice lane (voiceLane.cjs): it waits its turn (bounded by laneWaitMs), prints
// its position to stderr while waiting, and logs a usage line when it leaves.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// projectSounds.cjs requires this file only lazily, so this top-level require has no load cycle.
const { validateSounds, validateMemberSfx } = require('./projectSounds.cjs');
// Kit files are seeded to ~/.claude/session-manager/demo-video-kit/ and must
// load standalone: node built-ins and this folder only (no ../opsOwnership.cjs).
// Allowlisted for this literal in scripts/check-ops-path-literals.cjs ALLOWLIST.
const OPS_ROOT_DIR = 'session-manager-operations';

const MAX_JS_BYTES = 300 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
// Per narration line: slow CPU voices can take minutes for one sentence.
const COMMAND_TIMEOUT_MS = 900000;
const STDERR_TAIL = 500;
const BATCH_TIMEOUT_CEILING_MS = 180 * 60 * 1000;
const SPEAK_DEADLINE_MARGIN_MS = 45 * 60 * 1000;
const MIN_BATCH_TIMEOUT_MS = 60 * 1000;
const WAV_HEADER_BYTES = 44;
const LANE_WAIT_DEFAULT_MS = 6 * 60 * 60 * 1000;
const WAV_SCAN_BYTES = 64 * 1024;

const PERSONALITY_TEXT = Object.freeze({ who: 400, speech: 400, readingLevel: 40 });
const NEVER_SAY_MAX_ITEMS = 40;
const NEVER_SAY_MAX_CHARS = 40;
const MAX_CAST_MEMBERS = 8;
const CAST_NAME_MAX = 40;
const CAST_NOTE_MAX = 400;

/** -> null when `p` is a valid personality object, else a reason string. */
function validatePersonality(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'personality must be an object';
  for (const k of Object.keys(p)) {
    if (k === 'neverSay') continue;
    const max = PERSONALITY_TEXT[k];
    if (!max) return `personality.${k} is not a known key (who, speech, readingLevel, neverSay)`;
    const v = p[k];
    if (typeof v !== 'string' || v.length < 1 || v.length > max) return `personality.${k} must be a 1-${max} char string`;
  }
  if ('neverSay' in p) {
    const n = p.neverSay;
    if (!Array.isArray(n) || n.length > NEVER_SAY_MAX_ITEMS) {
      return `personality.neverSay must be an array of at most ${NEVER_SAY_MAX_ITEMS} strings`;
    }
    if (!n.every((w) => typeof w === 'string' && w.length >= 1 && w.length <= NEVER_SAY_MAX_CHARS)) {
      return `personality.neverSay items must be 1-${NEVER_SAY_MAX_CHARS} char strings`;
    }
  }
  return null;
}

/** -> null when `c` is a valid character.json object, else a reason string. */
function validateCharacterJson(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'character.json must be an object';
  if (typeof c.name !== 'string' || !c.name.trim()) return 'name must be a non-empty string';
  if (!Array.isArray(c.palette) || c.palette.length === 0 || !c.palette.every((p) => typeof p === 'string' && p)) {
    return 'palette must be a non-empty array of strings';
  }
  if ('personality' in c) {
    const pErr = validatePersonality(c.personality);
    if (pErr) return pErr;
  }
  const v = c.voice;
  if (!v || typeof v !== 'object') return 'voice is required';
  const vErr = validateVoiceOrRef(v, 'voice');
  if (vErr) return vErr;
  if ('sounds' in c) {
    const sErr = validateSounds(c.sounds);
    if (sErr) return sErr;
  }
  if ('cast' in c) return validateCast(c.cast, c.name, c.sounds);
  return null;
}

/** -> null when `v` is a valid voice ({engine:'kokoro',id} | {engine:'command',command}),
 * else a reason string prefixed with `label` (e.g. 'voice', 'cast[1].voice'). */
function validateVoice(v, label) {
  if (!v || typeof v !== 'object') return `${label} must be an object`;
  if (v.engine === 'kokoro') {
    if (typeof v.id !== 'string' || !v.id) return `${label}.id must be a non-empty string for engine kokoro`;
    return null;
  }
  if (v.engine === 'command') {
    const cmd = v.command;
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === 'string')) {
      return `${label}.command must be a non-empty string[]`;
    }
    if (!cmd[0]) return `${label}.command[0] must be a program name`;
    const batch = cmd.some((a) => a.includes('{lines}'));
    if (batch) {
      if (cmd.some((a) => a.includes('{text}') || a.includes('{out}'))) {
        return `${label}.command mixes {lines} with {text}/{out}; use {lines} alone or {text} with {out}`;
      }
      return null;
    }
    if (!cmd.some((a) => a.includes('{text}'))) return `${label}.command must contain a {text} placeholder`;
    if (!cmd.some((a) => a.includes('{out}'))) return `${label}.command must contain an {out} placeholder`;
    return null;
  }
  return `${label}.engine must be 'kokoro' or 'command'`;
}

/** True when `v` is a voice-library reference ({voiceId, ...}) rather than an inline engine voice. */
function isVoiceIdRef(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'voiceId' in v;
}

/** A {voiceId} ref (exactly that one key, a library id) or an inline voice. The ref is
 * only checked for shape here; the write route resolves it in the voice library. */
function validateVoiceOrRef(v, label) {
  if (!isVoiceIdRef(v)) return validateVoice(v, label);
  for (const k of Object.keys(v)) {
    if (k !== 'voiceId') return `${label}.${k} is not allowed beside voiceId; a {voiceId} voice has exactly one key`;
  }
  // Lazy: voiceLibrary.cjs requires this file at load, so a top-level require would see it half-built.
  const { VOICE_ID_RE } = require('./voiceLibrary.cjs');
  if (typeof v.voiceId !== 'string' || !VOICE_ID_RE.test(v.voiceId)) return `${label}.voiceId must match ${VOICE_ID_RE}`;
  return null;
}

/** Every {voiceId} the host and cast name, in order: [{ label, voiceId }]. Assumes a valid character.json. */
function voiceIdRefsOf(c) {
  const refs = [];
  if (c && isVoiceIdRef(c.voice)) refs.push({ label: 'voice', voiceId: c.voice.voiceId });
  if (c && Array.isArray(c.cast)) {
    c.cast.forEach((m, i) => { if (m && isVoiceIdRef(m.voice)) refs.push({ label: `cast[${i}].voice`, voiceId: m.voice.voiceId }); });
  }
  return refs;
}

const CAST_KEYS = Object.freeze(['name', 'voice', 'note', 'sfx']);

/** -> null when `cast` is a valid supporting cast for host `hostName`, else a reason.
 * A member without `voice` is valid: it never speaks, and is heard only through sound
 * effects. A member's optional `sfx` names its signature sounds (built-in effects or the
 * persona's `sounds.sfx`, passed as `sounds`). */
function validateCast(cast, hostName, sounds) {
  if (!Array.isArray(cast) || cast.length > MAX_CAST_MEMBERS) {
    return `cast must be an array of at most ${MAX_CAST_MEMBERS} members`;
  }
  const host = String(hostName).trim().toLowerCase();
  const seen = new Map();
  for (let i = 0; i < cast.length; i++) {
    const m = cast[i];
    const at = `cast[${i}]`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return `${at} must be an object`;
    for (const k of Object.keys(m)) {
      if (!CAST_KEYS.includes(k)) return `${at}.${k} is not a known key (${CAST_KEYS.join(', ')})`;
    }
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (name.length < 1 || name.length > CAST_NAME_MAX) return `${at}.name must be a 1-${CAST_NAME_MAX} char string`;
    const key = name.toLowerCase();
    if (key === host) return `${at}.name "${name}" is the host's name`;
    if (seen.has(key)) return `${at}.name "${name}" duplicates cast[${seen.get(key)}].name`;
    seen.set(key, i);
    if ('voice' in m) {
      const vErr = validateVoiceOrRef(m.voice, `${at}.voice`);
      if (vErr) return vErr;
    }
    if ('note' in m && (typeof m.note !== 'string' || m.note.length < 1 || m.note.length > CAST_NOTE_MAX)) {
      return `${at}.note must be a 1-${CAST_NOTE_MAX} char string`;
    }
    if ('sfx' in m) {
      const fErr = validateMemberSfx(m.sfx, `${at}.sfx`, sounds);
      if (fErr) return fErr;
    }
  }
  return null;
}

/** -> null when `js` is acceptable character.js source, else a reason. Needs the
 * route's network checks, so they are injected (avoids a require cycle). */
function validateCharacterJs(js, networkChecks = []) {
  if (typeof js !== 'string' || !js.trim()) return 'js must be a non-empty string';
  if (Buffer.byteLength(js, 'utf8') > MAX_JS_BYTES) return `js exceeds the ${MAX_JS_BYTES}-byte limit`;
  for (const { re, message } of networkChecks) {
    if (re.test(js)) return `js must not be network-capable: ${message}`;
  }
  return null;
}

/**
 * Local stand-in for opsOwnership.opsPath(projectRoot, 'project-pages', ...):
 * requires an absolute path and normalizes a path inside the ops root back to
 * its project root, so the result always lands in
 * `<projectRoot>/session-manager-operations/project-pages/videos/_character`.
 * Callers pass an already-resolved project root; writes stay guarded by the
 * caller's writer-checked writeTextAtomic (assertOpsWrite).
 */
function characterDir(projectRoot) {
  return path.join(projectRootOf(projectRoot, 'characterDir'), OPS_ROOT_DIR, 'project-pages', 'videos', '_character');
}

/** The project root for `projectRoot` (absolute), with any ops-root suffix stripped. */
function projectRootOf(projectRoot, who = 'projectRootOf') {
  if (!projectRoot || typeof projectRoot !== 'string') throw new Error(`${who}: projectRoot is required`);
  if (!path.isAbsolute(projectRoot)) {
    throw new Error(`${who}: projectRoot must be an absolute path, got "${projectRoot}"`);
  }
  const segs = path.resolve(projectRoot).split(path.sep);
  const idx = segs.indexOf(OPS_ROOT_DIR);
  return idx === -1 ? segs.join(path.sep) : (segs.slice(0, idx).join(path.sep) || path.sep);
}

/**
 * -> { ok: true, json, js } | { ok: false, exists, error }.
 * `exists` is true when character.json or character.js is on disk, so callers
 * can tell 'no persona saved' from 'a persona is saved but unusable'.
 */
function inspectCharacter(projectRoot) {
  let dir;
  try {
    dir = characterDir(projectRoot);
  } catch (e) {
    return { ok: false, exists: false, error: e.message };
  }
  const jsonPath = path.join(dir, 'character.json');
  const jsPath = path.join(dir, 'character.js');
  const hasJson = fs.existsSync(jsonPath);
  const hasJs = fs.existsSync(jsPath);
  const exists = hasJson || hasJs;
  const fail = (error) => ({ ok: false, exists, error });
  if (!exists) return fail(`no character saved in ${dir}`);
  if (!hasJson) return fail(`character.json is missing in ${dir}`);
  let json;
  try {
    const jsonRaw = fs.readFileSync(jsonPath, 'utf8');
    if (Buffer.byteLength(jsonRaw, 'utf8') > MAX_JSON_BYTES) {
      return fail(`character.json exceeds the ${MAX_JSON_BYTES}-byte limit`);
    }
    json = JSON.parse(jsonRaw);
  } catch (e) {
    return fail(`character.json is not valid JSON: ${e.message}`);
  }
  const reason = validateCharacterJson(json);
  if (reason) return fail(`character.json invalid: ${reason}`);
  if (!hasJs) return fail(`character.js is missing in ${dir}`);
  let js;
  try {
    js = fs.readFileSync(jsPath, 'utf8');
  } catch (e) {
    return fail(`character.js cannot be read: ${e.message}`);
  }
  if (!js.trim()) return fail('character.js is empty');
  return { ok: true, json, js };
}

/** -> {json, js} | null (absent or invalid). */
function readCharacter(projectRoot) {
  const r = inspectCharacter(projectRoot);
  return r.ok ? { json: r.json, js: r.js } : null;
}

/** Substitute {text}/{out} into each argv element; the argv is never joined. */
function buildCommandArgv(voice, text, out) {
  return voice.command.map((a) => a.split('{text}').join(text).split('{out}').join(out));
}

/** True only for a valid engine 'command' voice whose command holds '{lines}' (one call per speaker). */
function isBatchVoice(voice) {
  return !!voice && voice.engine === 'command' && validateVoice(voice, 'voice') === null
    && voice.command.some((a) => a.includes('{lines}'));
}

/** Substitute {lines} (the manifest path) into each argv element; the argv is never joined. */
function buildBatchArgv(voice, manifestPath) {
  return voice.command.map((a) => a.split('{lines}').join(manifestPath));
}

/** True when `file` exists, is larger than a bare WAV header and starts with 'RIFF'. */
function isWav(file) {
  let fd;
  try {
    if (fs.statSync(file).size <= WAV_HEADER_BYTES) return false;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head.toString('latin1') === 'RIFF';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Seconds of audio in a WAV from its RIFF fmt byteRate and data chunk size; 0 when unparseable. */
function wavSeconds(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, WAV_SCAN_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return 0;
    let byteRate = 0;
    for (let off = 12; off + 8 <= buf.length;) {
      const id = buf.toString('latin1', off, off + 4);
      const len = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 16 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data') {
        if (!(byteRate > 0)) return 0;
        const bytes = Math.min(len, Math.max(0, size - off - 8));
        return bytes / byteRate;
      }
      off += 8 + len + (len % 2);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Time kept back from speaking for mixing and saving the video, given `leftMs` before the
 * job deadline: a quarter of it, at most SPEAK_DEADLINE_MARGIN_MS (45 min). Short jobs still
 * get three quarters of their time to speak; long jobs keep the full 45 minutes.
 */
function speakReserveMs(leftMs) {
  return Math.min(SPEAK_DEADLINE_MARGIN_MS, Math.floor(leftMs / 4));
}

/** env.SM_SCHEDULER_JOB_DEADLINE_MS as a finite number, else null. */
function jobDeadline(env) {
  const raw = env && env.SM_SCHEDULER_JOB_DEADLINE_MS;
  const deadline = Number(raw);
  return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(deadline) ? deadline : null;
}

/** Minutes with one decimal, for error messages. */
function fmtMin(ms) {
  return Math.round(Math.max(0, ms) / 6000) / 10;
}

/**
 * ' (<N> min left before the job deadline, <M> min kept in reserve)' when
 * env.SM_SCHEDULER_JOB_DEADLINE_MS is set, else ''. The one suffix both the batch time-limit
 * error and the voice-lane timeout use, so the two messages say the same thing.
 */
function deadlineContext({ now = Date.now(), env = process.env } = {}) {
  const deadline = jobDeadline(env);
  if (deadline === null) return '';
  const leftMs = deadline - now;
  return ` (${fmtMin(leftMs)} min left before the job deadline, ${fmtMin(speakReserveMs(leftMs))} min kept in reserve)`;
}

/**
 * How long one synthesis call may wait for its voice lane: the time left before
 * env.SM_SCHEDULER_JOB_DEADLINE_MS minus speakReserveMs(time left) when that is set
 * (may be <= 0: no time left), else LANE_WAIT_DEFAULT_MS (6 h).
 */
function laneWaitMs({ now = Date.now(), env = process.env } = {}) {
  const deadline = jobDeadline(env);
  if (deadline !== null) return deadline - now - speakReserveMs(deadline - now);
  return LANE_WAIT_DEFAULT_MS;
}

/** 'voice lane: waiting, position 1 of 2 (ahead: video demo inline:command)' — ahead = the lane holder. */
function lanePositionLine(pos) {
  const h = pos && Array.isArray(pos.ahead) && pos.ahead.length ? pos.ahead[0] : null;
  const ahead = h ? `${h.label ?? '?'} ${h.voiceId ?? '?'}` : '?';
  return `voice lane: waiting, position ${pos.position} of ${pos.total} (ahead: ${ahead})`;
}

/**
 * Run one synthesis call `fn` (-> {ok, error?}) inside the voice lane of rv's voice.
 * ctx: {root, kind, label, onLanePosition?}. Always leaves the lane; the usage line
 * carries ok, audioSeconds (sum over `outs`' WAV headers) and wallMs.
 */
function inLane(ctx, rv, outs, fn) {
  const lane = require('./voiceLane.cjs');
  const voiceId = rv.voiceId ? String(rv.voiceId) : `inline:${rv.voice.engine}`;
  const ticket = lane.enterLane({ lane: lane.laneFor(rv.voice, rv.entry), voiceId, label: ctx.label, projectRoot: ctx.root, kind: ctx.kind });
  let granted = false;
  let ok = false;
  try {
    const now = Date.now();
    const env = process.env;
    const left = laneWaitMs({ now, env });
    const w = lane.waitTurn(ticket, {
      timeoutMs: Math.max(1, left),
      onPosition: (pos) => {
        if (pos.position > 0) process.stderr.write(`${lanePositionLine(pos)}\n`);
        if (typeof ctx.onLanePosition === 'function') ctx.onLanePosition({ lane: ticket.lane, ...pos });
      },
    });
    if (!w.ok) {
      return { ok: false, error: `${w.error}${deadlineContext({ now, env })}` };
    }
    granted = true;
    const r = fn();
    ok = !!(r && r.ok);
    return r;
  } finally {
    if (granted) {
      const audioSeconds = outs.reduce((sum, o) => sum + wavSeconds(o), 0);
      lane.leaveLane(ticket, { ok, audioSeconds: Math.round(audioSeconds * 1000) / 1000 });
    } else {
      lane.leaveLane(ticket, { ok: false, record: false });
    }
  }
}

/**
 * Run the voice command (no shell). -> {ok, status, error?}
 * ok only when the command exited 0 AND wrote a WAV to `out`; the error carries
 * the last STDERR_TAIL chars of the command's stderr.
 */
function speakWithCommand(voice, text, out, { cwd } = {}) {
  if (!voice || voice.engine !== 'command' || validateVoice(voice, 'voice')) {
    return { ok: false, status: null, error: 'not a valid command voice' };
  }
  if (isBatchVoice(voice)) {
    return { ok: false, status: null, error: 'a {lines} voice is spoken by speakLines in one call per speaker, not per line' };
  }
  const outStr = String(out);
  const [bin, ...args] = buildCommandArgv(voice, String(text), outStr);
  const r = spawnSync(bin, args, {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  const stderr = r.stderr ? r.stderr.toString('utf8').trim().slice(-STDERR_TAIL) : '';
  const withStderr = (msg) => (stderr ? `${msg}: ${stderr}` : msg);
  if (r.error) return { ok: false, status: r.status, error: withStderr(r.error.message) };
  if (r.status !== 0) {
    const why = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    return { ok: false, status: r.status, error: withStderr(`voice command failed (${why})`) };
  }
  const outAbs = path.resolve(cwd || process.cwd(), outStr);
  if (!isWav(outAbs)) {
    return { ok: false, status: r.status, error: withStderr(`the voice command wrote no WAV to ${outAbs}`) };
  }
  return { ok: true, status: r.status };
}

/**
 * Time limit for one batch voice call over `lineCount` lines -> {ok: true, ms} | {ok: false, error}.
 * ms = min(lineCount * COMMAND_TIMEOUT_MS, BATCH_TIMEOUT_CEILING_MS), capped at the scheduler's
 * job deadline (env.SM_SCHEDULER_JOB_DEADLINE_MS) minus speakReserveMs(time left) when that is a
 * finite number: the voice runs first, so the whole video is still to be built after it.
 */
function batchTimeoutMs(lineCount, { now = Date.now(), env = process.env } = {}) {
  let ms = Math.min(lineCount * COMMAND_TIMEOUT_MS, BATCH_TIMEOUT_CEILING_MS);
  const deadline = jobDeadline(env);
  const leftMs = deadline === null ? null : deadline - now;
  if (leftMs !== null) ms = Math.min(ms, leftMs - speakReserveMs(leftMs));
  if (ms < MIN_BATCH_TIMEOUT_MS) {
    const left = Math.max(0, Math.floor(ms / 1000));
    const ctx = deadlineContext({ now, env });
    return {
      ok: false,
      error: `only ${left}s left to speak for ${lineCount} lines${ctx}; need at least ${MIN_BATCH_TIMEOUT_MS / 1000}s`,
    };
  }
  return { ok: true, ms };
}

/**
 * Run one batch ({lines}) voice over `items` ([{ text, out }], out absolute), cwd = root.
 * -> {ok: true} | {ok: false, error}. Old files at the outs are removed first; stderr goes
 * to a file (never a pipe) so a long run cannot overflow spawnSync's maxBuffer.
 */
function speakBatch(voice, items, root) {
  const limit = batchTimeoutMs(items.length);
  if (!limit.ok) return limit;
  for (const it of items) {
    try {
      fs.rmSync(it.out, { force: true });
    } catch (e) {
      return { ok: false, error: `cannot clear ${it.out}: ${e.message}` };
    }
  }
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voice-'));
    const manifest = path.join(dir, 'lines.json');
    fs.writeFileSync(manifest, JSON.stringify(items.map(({ text, out }) => ({ text, out }))));
    const errPath = path.join(dir, 'stderr.log');
    const errFd = fs.openSync(errPath, 'w');
    let r;
    try {
      const [bin, ...args] = buildBatchArgv(voice, manifest);
      r = spawnSync(bin, args, { shell: false, stdio: ['ignore', 'ignore', errFd], timeout: limit.ms, cwd: root });
    } finally {
      fs.closeSync(errFd);
    }
    let stderr = '';
    try { stderr = fs.readFileSync(errPath, 'utf8').trim().slice(-STDERR_TAIL); } catch { /* none */ }
    const withStderr = (msg) => (stderr ? `${msg}: ${stderr}` : msg);
    const mins = Math.round((limit.ms / 60000) * 10) / 10;
    if (r.error && r.error.code === 'ETIMEDOUT') {
      return { ok: false, error: withStderr(`voice command killed by ${r.signal || 'SIGTERM'} at its ${mins} min limit`) };
    }
    if (r.error) return { ok: false, error: withStderr(r.error.message) };
    if (r.status !== 0) {
      const why = r.signal ? `killed by ${r.signal} (limit ${mins} min)` : `exit ${r.status}`;
      return { ok: false, error: withStderr(`voice command failed (${why})`) };
    }
    const missing = items.filter((it) => !isWav(it.out)).map((it) => it.out);
    if (missing.length) {
      return { ok: false, error: withStderr(`the voice command left ${missing.length} of ${items.length} outs missing (no WAV at ${missing[0]})`) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Resolve one speaker's voice to an inline engine voice. A {voiceId} ref (or a bare
 * id string) goes through voiceLibrary.resolveVoiceId; an inline voice is checked
 * with validateVoice. -> {ok: true, voice, voiceId?, entry?} | {ok: false, voiceId?, error}
 */
function resolveSpeakerVoice(root, voice) {
  const v = typeof voice === 'string' ? { voiceId: voice } : voice;
  if (isVoiceIdRef(v)) {
    const refErr = validateVoiceOrRef(v, 'voice');
    if (refErr) return { ok: false, voiceId: String(v.voiceId), error: refErr };
    // Lazy: voiceLibrary.cjs requires this file.
    const r = require('./voiceLibrary.cjs').resolveVoiceId(root, v.voiceId);
    if (!r.ok) return { ok: false, voiceId: v.voiceId, error: r.error };
    return { ok: true, voice: r.voice, voiceId: v.voiceId, entry: r.entry };
  }
  const err = validateVoice(v, 'voice');
  if (err) return { ok: false, error: err };
  return { ok: true, voice: v };
}

/** 'af_heart' / 'kokoro af_heart' / 'command bin/tts' — names a voice in an error. */
function voiceLabel(rv, voice) {
  if (rv && rv.voiceId) return `voice '${rv.voiceId}'`;
  const v = rv && rv.voice ? rv.voice : voice;
  if (v && v.engine === 'kokoro') return `kokoro voice '${v.id}'`;
  if (v && v.engine === 'command' && Array.isArray(v.command)) return `command voice '${v.command[0]}'`;
  return 'voice';
}

/** One Kokoro group: every line of one speaker in ONE sayKokoro call, within batchTimeoutMs. */
function speakKokoro(voice, items, root) {
  const limit = batchTimeoutMs(items.length);
  if (!limit.ok) return limit;
  const { sayKokoro } = require('./kokoroSay.cjs');
  const r = sayKokoro(kokoroItems(voice, items), { cwd: root, timeoutMs: limit.ms });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

function kokoroItems(voice, items) {
  return items.map((l) => ({ text: l.text, out: l.out, voice: voice.id, speed: voice.speed, lang: voice.lang }));
}

/**
 * Speak every narration line, in order, cwd = the project root. A line is
 * { text, out, speaker? }: an absent/null speaker (or the host's name) uses the
 * host's voice; a cast member's name (case-insensitive, trimmed) uses that
 * member's voice. opts.voice (a library voice id or an inline voice) replaces the
 * host's voice for this run only, and needs no saved character (then a named
 * speaker is refused). A {voiceId} voice resolves through voiceLibrary.resolveVoiceId.
 * Every line's speaker and voice are resolved before any voice runs. A per-line
 * ({text}/{out}) command voice runs once per line. A batch ({lines}) command voice
 * runs ONCE, at its speaker's first line, over a JSON manifest [{ text, out }] of
 * all its lines; a kokoro voice runs ONCE per speaker the same way through
 * kokoroSay.sayKokoro (its id, speed, lang). Grouped outs must end in .wav and be
 * distinct; groups run within batchTimeoutMs and succeed only when every out is a
 * WAV. No fallback voice: the first failure stops the run.
 * Every call (per line, per batch group, per kokoro group) runs in the voice lane
 * voiceLane.laneFor(voice, entry); opts.kind (default 'video') and opts.label
 * (default 'video <basename of root>') go on the lane ticket and usage line, and
 * opts.onLanePosition(pos) sees each lane position change.
 * -> {ok: true, outs} | {ok: false, line?, lines?, speaker?, error}
 */
function speakLines(projectRoot, lines, opts = {}) {
  let root;
  try {
    root = projectRootOf(projectRoot, 'speakLines');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: 'lines must be a non-empty array of { text, out, speaker? }' };
  const laneCtx = {
    root,
    kind: opts && typeof opts.kind === 'string' && opts.kind ? opts.kind : 'video',
    label: opts && typeof opts.label === 'string' && opts.label ? opts.label : `video ${path.basename(root)}`,
    onLanePosition: opts ? opts.onLanePosition : undefined,
  };
  const override = opts && opts.voice !== undefined && opts.voice !== null ? opts.voice : undefined;
  if (override !== undefined) {
    const ov = typeof override === 'string' ? { voiceId: override } : override;
    const oErr = !ov || typeof ov !== 'object' || Array.isArray(ov)
      ? 'spec.voice must be a voice id string or a voice object'
      : validateVoiceOrRef(ov, 'spec.voice');
    if (oErr) return { ok: false, error: oErr };
  }
  const ch = inspectCharacter(root);
  const noCharacter = !ch.ok && !ch.exists && override !== undefined;
  if (!ch.ok && !noCharacter) return { ok: false, error: `no valid saved character in ${characterDir(root)}: ${ch.error}` };
  const host = noCharacter
    ? { name: 'spec.voice', voice: override }
    : { name: ch.json.name, voice: override !== undefined ? override : ch.json.voice };
  const cast = !noCharacter && Array.isArray(ch.json.cast) ? ch.json.cast : [];
  const speakers = [host, ...cast];
  const byKey = noCharacter ? new Map() : new Map(speakers.map((m) => [String(m.name).trim().toLowerCase(), m]));
  const names = speakers.map((m) => String(m.name).trim());
  const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
  const voices = new Map(); // speaker name -> resolveSpeakerVoice result
  const resolved = [];
  const groups = new Map(); // speaker name -> { kind: 'batch'|'kokoro', voice, indices, seen: Map<absOut, lineIndex> }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sp = l ? l.speaker : undefined;
    if (!l || !nonEmpty(l.text) || !nonEmpty(l.out) || !(sp === undefined || sp === null || (nonEmpty(sp) && sp.trim()))) {
      return { ok: false, line: i, error: `line ${i} must be { text, out, speaker? } with non-empty strings` };
    }
    if (noCharacter && !(sp === undefined || sp === null)) {
      return { ok: false, line: i, error: `line ${i}: speaker "${sp}" is refused: no character is saved, so only spec.voice speaks (omit speaker)` };
    }
    const m = sp === undefined || sp === null ? host : byKey.get(sp.trim().toLowerCase());
    if (!m) return { ok: false, line: i, error: `line ${i}: unknown speaker "${sp}" (speakers: ${names.join(', ')})` };
    const name = String(m.name).trim();
    if (!m.voice) return { ok: false, line: i, error: `line ${i}: "${name}" has no voice and never speaks lines` };
    let rv = voices.get(name);
    if (!rv) { rv = resolveSpeakerVoice(root, m.voice); voices.set(name, rv); }
    if (!rv.ok) return { ok: false, line: i, speaker: name, error: `line ${i}: "${name}" ${voiceLabel(rv, m.voice)}: ${rv.error}` };
    const voice = rv.voice;
    const kind = voice.engine === 'kokoro' ? 'kokoro' : isBatchVoice(voice) ? 'batch' : null;
    if (kind) {
      const what = kind === 'kokoro' ? 'a kokoro' : 'a {lines}';
      if (!l.out.toLowerCase().endsWith('.wav')) return { ok: false, line: i, error: `line ${i}: ${what} voice's out must end in .wav` };
      const abs = path.resolve(root, l.out);
      let b = groups.get(name);
      if (!b) { b = { kind, voice, rv, label: voiceLabel(rv), indices: [], seen: new Map() }; groups.set(name, b); }
      if (b.seen.has(abs)) return { ok: false, line: i, error: `line ${i}: out ${abs} repeats line ${b.seen.get(abs)}'s out` };
      b.seen.set(abs, i);
      b.indices.push(i);
    }
    resolved.push({ name, voice, rv, label: voiceLabel(rv), text: l.text, out: l.out });
  }
  const itemsOf = (b) => b.indices.map((j) => ({ text: resolved[j].text, out: path.resolve(root, resolved[j].out) }));
  for (const [name, b] of groups) {
    if (b.kind !== 'kokoro') continue;
    const v = require('./kokoroSay.cjs').validateLines(kokoroItems(b.voice, itemsOf(b)), root);
    if (!v.ok) return { ok: false, line: b.indices[0], lines: b.indices.slice(), speaker: name, error: `"${name}" ${b.label}: ${v.error}` };
  }
  const outs = [];
  const spoken = new Set();
  for (let i = 0; i < resolved.length; i++) {
    const { name, voice, rv, label, text, out } = resolved[i];
    const b = groups.get(name);
    if (b) {
      if (!spoken.has(name)) {
        spoken.add(name);
        const items = itemsOf(b);
        const r = inLane(laneCtx, b.rv, items.map((it) => it.out), () => (b.kind === 'kokoro' ? speakKokoro(b.voice, items, root) : speakBatch(b.voice, items, root)));
        if (!r.ok) {
          const who = b.kind === 'kokoro' ? `"${name}" ${b.label}` : `"${name}"`;
          return { ok: false, line: b.indices[0], lines: b.indices.slice(), speaker: name, error: `${who}: ${r.error}` };
        }
      }
    } else {
      const r = inLane(laneCtx, rv, [path.resolve(root, out)], () => speakWithCommand(voice, text, out, { cwd: root }));
      if (!r.ok) return { ok: false, line: i, speaker: name, error: `"${name}"${label.startsWith('voice ') ? ` ${label}` : ''}: ${r.error}` };
    }
    outs.push(out);
  }
  return { ok: true, outs };
}

module.exports = {
  readCharacter,
  speakWithCommand,
  speakLines,
  resolveSpeakerVoice,
  buildCommandArgv,
  buildBatchArgv,
  isBatchVoice,
  wavSeconds,
  laneWaitMs,
  deadlineContext,
  speakReserveMs,
  lanePositionLine,
  LANE_WAIT_DEFAULT_MS,
  validateCharacterJson,
  validateCharacterJs,
  validatePersonality,
  validateVoice,
  isVoiceIdRef,
  voiceIdRefsOf,
  inspectCharacter,
  characterDir,
  MAX_JS_BYTES,
  MAX_JSON_BYTES,
  MAX_CAST_MEMBERS,
  COMMAND_TIMEOUT_MS,
  batchTimeoutMs,
  BATCH_TIMEOUT_CEILING_MS,
  SPEAK_DEADLINE_MARGIN_MS,
  MIN_BATCH_TIMEOUT_MS,
};

// CLI: node character.cjs speak spec.json [--wait <seconds>]
//   (spec { projectRoot, lines: [{ text, out, speaker? }], voice?, kind?, label? }; voice = a
//   library voice id or an inline voice replacing the host's voice for this run; kind and
//   label name the run in the voice lane and its usage log)
// speakLines runs in a detached runner (resumableRun.cjs) keyed by the sha256
// of the spec bytes, state in <abs spec>.run/. Each call waits one slice: the
// result (exit 0/1) or, while still speaking, a pending line with exit 75 —
// run the same command again to attach to the same run. The runner writes its
// latest voice lane position to <abs spec>.run/lane.json; the pending line carries it.
const SPEAK_USAGE = 'usage: node character.cjs speak spec.json [--wait seconds]';
const EXIT_PENDING = 75;
const MAX_WAIT_S = 840;

/** Slice length in ms from --wait, else BASH_DEFAULT_TIMEOUT_MS - 30 s clamped to 10-840 s, else 90 s. */
function speakWaitMs(flags, env = process.env) {
  if (flags.length) {
    if (flags.length !== 2 || flags[0] !== '--wait' || !/^\d+$/.test(flags[1])) return null;
    const n = Number(flags[1]);
    return n >= 1 && n <= MAX_WAIT_S ? n * 1000 : null;
  }
  const bash = Number(env.BASH_DEFAULT_TIMEOUT_MS);
  if (!(bash > 0)) return 90 * 1000;
  return Math.min(MAX_WAIT_S * 1000, Math.max(10 * 1000, bash - 30 * 1000));
}

const lanePath = (stateDir) => path.join(stateDir, 'lane.json');

function specOuts(spec) {
  const lines = spec && Array.isArray(spec.lines) ? spec.lines : [];
  const root = spec && typeof spec.projectRoot === 'string' ? spec.projectRoot : '';
  return lines.map((l) => (l && typeof l.out === 'string' && l.out ? path.resolve(root, l.out) : null));
}

function readSpec(specPath) {
  const bytes = fs.readFileSync(specPath);
  return { bytes, spec: JSON.parse(bytes.toString('utf8')) };
}

async function speakCli(specPath, flags) {
  const waitMs = speakWaitMs(flags);
  if (waitMs === null) return { result: { ok: false, error: SPEAK_USAGE } };
  let bytes;
  let spec;
  try {
    ({ bytes, spec } = readSpec(specPath));
  } catch (e) {
    return { result: { ok: false, error: `cannot read spec ${specPath}: ${e.message}` } };
  }
  const rr = require('./resumableRun.cjs');
  const crypto = require('node:crypto');
  const key = crypto.createHash('sha256').update(bytes).digest('hex');
  const absSpec = path.resolve(specPath);
  const stateDir = `${absSpec}.run`;
  const outs = specOuts(spec);
  const allWavs = () => outs.length > 0 && outs.every((o) => o && isWav(o));
  let prior = null;
  try { prior = JSON.parse(fs.readFileSync(path.join(stateDir, 'result.json'), 'utf8')); } catch { /* none yet */ }
  if (prior && prior.key === key && prior.result && prior.result.ok === true) {
    if (allWavs()) return { result: prior.result };
    rr.stopRun(stateDir);
  }
  const att = rr.startOrAttach({ stateDir, key, argv: [__filename, '__speak-run', absSpec, key], cwd: path.dirname(absSpec) });
  if (att.started) fs.rmSync(lanePath(stateDir), { force: true });
  const w = await rr.waitForResult({ stateDir, key, waitMs });
  if (w.status === 'done') return { result: w.result };
  if (w.status === 'lost') return { result: { ok: false, error: `speak runner (node character.cjs __speak-run ${absSpec}): ${w.error}` } };
  const wavs = outs.filter((o) => o && isWav(o)).length;
  let lane = null;
  try { const j = JSON.parse(fs.readFileSync(lanePath(stateDir), 'utf8')); if (j && j.key === key && j.pos) lane = j.pos; } catch { /* not in a lane yet */ }
  const waiting = lane && lane.position > 0 ? `; ${lanePositionLine(lane)}` : '';
  return {
    pending: true,
    result: {
      ok: false,
      pending: true,
      pid: w.pid,
      elapsedS: Math.round(w.elapsedMs / 1000),
      wavs,
      lines: outs.length,
      ...(lane ? { lane: { lane: lane.lane, position: lane.position, total: lane.total, ahead: lane.ahead } } : {}),
      message: `still speaking (${wavs}/${outs.length} WAVs so far${waiting}); run the same command again`,
    },
  };
}

function speakRunner(specPath, key) {
  const rr = require('./resumableRun.cjs');
  const crypto = require('node:crypto');
  const stateDir = `${path.resolve(specPath)}.run`;
  let result;
  try {
    const { bytes, spec } = readSpec(specPath);
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    result = got !== key
      ? { ok: false, error: `spec ${specPath} changed since this run started` }
      : speakLines(spec && spec.projectRoot, spec && spec.lines, {
        voice: spec ? spec.voice : undefined,
        kind: spec ? spec.kind : undefined,
        label: spec ? spec.label : undefined,
        onLanePosition: (pos) => {
          try { fs.writeFileSync(lanePath(stateDir), JSON.stringify({ key, pos })); } catch { /* stateDir gone: run stopped */ }
        },
      });
  } catch (e) {
    result = { ok: false, error: `cannot read spec ${specPath}: ${e.message}` };
  }
  rr.writeResult(stateDir, key, result);
}

async function main(argv) {
  const [cmdName, specPath, ...rest] = argv;
  if (cmdName === '__speak-run' && specPath && rest.length === 1 && rest[0]) {
    speakRunner(specPath, rest[0]);
    process.exitCode = 0; // the waiting call reports failures
    return;
  }
  const out = cmdName === 'speak' && specPath
    ? await speakCli(specPath, rest)
    : { result: { ok: false, error: SPEAK_USAGE } };
  const { result } = out;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (out.pending) {
    process.exitCode = EXIT_PENDING;
  } else if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) })}\n`);
    process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}
