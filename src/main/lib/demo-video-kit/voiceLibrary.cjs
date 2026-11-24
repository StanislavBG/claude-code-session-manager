'use strict';
// Demo-video kit voice library: the ONE resolver for library voices.
// Three scopes, highest first (like agents):
//   project  <projectRoot>/.claude/voices/<id>.json
//   machine  <voicesHome>/library/<id>.json
//   builtin  every voice in the installed Kokoro model (voices-v1.0.bin zip),
//            or KOKORO_V1_VOICES (installed:false) when the model is absent.
// A higher scope shadows a lower one with the same id. Approvals live in
// <voicesHome>/approvals.json; this module only READS them. An approved voice
// whose pin no longer matches, or whose file is gone, is refused — never used,
// never replaced by a lower scope.
// Kit files are seeded to ~/.claude/session-manager/demo-video-kit/ and must
// load standalone: node built-ins and this folder only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateCharacterJson } = require('./character.cjs');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_ENTRY_BYTES = 16 * 1024;
const LABEL_MAX = 80;
const SAMPLE_MAX = 300;
const LICENCE_MAX = 120;
const PIN_FILES_MAX = 8;
const DEFAULT_SAMPLE = 'Hello! This is how I sound when I tell your project story.';
const BUILTIN_LICENCE = 'Apache-2.0 (Kokoro-82M)';
const SCOPE_ORDER = Object.freeze({ project: 0, machine: 1, builtin: 2 });

const KOKORO_V1_VOICES = Object.freeze([
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  'ef_dora', 'em_alex', 'em_santa', 'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
  'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
  'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
]);

const KOKORO_LANGS = Object.freeze({
  a: 'US', b: 'UK', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Brazilian Portuguese', z: 'Mandarin',
});
const KOKORO_GENDERS = Object.freeze({ f: 'female', m: 'male' });

function voicesHome() {
  return process.env.SM_VOICES_HOME || path.join(os.homedir(), '.claude', 'session-manager', 'voices');
}

function kokoroModelDir() {
  return process.env.KOKORO_MODEL_DIR || path.join(os.homedir(), '.cache', 'kokoro-onnx');
}

function projectVoicesDir(projectRoot) {
  return projectRoot ? path.join(path.resolve(projectRoot), '.claude', 'voices') : null;
}

function machineVoicesDir() {
  return path.join(voicesHome(), 'library');
}

/** 'af_heart' -> 'Heart (US female)'. */
function builtinLabel(id) {
  const m = /^([a-z])([a-z])_(.+)$/.exec(id);
  if (!m) return id;
  const name = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  const lang = KOKORO_LANGS[m[1]];
  const gender = KOKORO_GENDERS[m[2]];
  const tags = [lang, gender].filter(Boolean).join(' ');
  return tags ? `${name} (${tags})` : name;
}

/** Entry names in a zip's central directory; throws on a non-zip. Reads only the tail + directory. */
function zipEntryNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65536 + 22);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('no zip end-of-central-directory record');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size) throw new Error('zip central directory out of range');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const names = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory entry');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

function builtinEntry(id, installed) {
  return {
    id,
    label: builtinLabel(id),
    voice: { engine: 'kokoro', id },
    engine: 'kokoro',
    sampleText: DEFAULT_SAMPLE,
    licence: BUILTIN_LICENCE,
    heavy: false,
    scope: 'builtin',
    installed,
  };
}

function builtinVoices() {
  let ids = null;
  try {
    const names = zipEntryNames(path.join(kokoroModelDir(), 'voices-v1.0.bin'));
    ids = names.filter((n) => n.endsWith('.npy')).map((n) => path.posix.basename(n).slice(0, -4)).filter(Boolean);
    if (ids.length === 0) ids = null;
  } catch { /* missing or unreadable: fall back */ }
  if (ids) return [...new Set(ids)].map((id) => builtinEntry(id, true));
  return KOKORO_V1_VOICES.map((id) => builtinEntry(id, false));
}

/** -> null when `json` is a valid voice entry for file stem `stem`, else a reason string. */
function validateVoiceEntry(json, stem) {
  if (typeof stem !== 'string' || !ID_RE.test(stem)) return `file name '${stem}' must match ${ID_RE}`;
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'voice entry must be an object';
  if ('id' in json && json.id !== stem) return `id '${json.id}' must equal the file name '${stem}'`;
  if ('label' in json && (typeof json.label !== 'string' || json.label.length < 1 || json.label.length > LABEL_MAX)) {
    return `label must be a 1-${LABEL_MAX} char string`;
  }
  const v = json.voice;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'voice is required';
  if ('voiceId' in v) return 'voice must be an inline voice, not a {voiceId} reference (no chains)';
  const vErr = validateCharacterJson({ name: 'x', palette: ['x'], voice: v });
  if (vErr) return vErr;
  if ('sampleText' in json && (typeof json.sampleText !== 'string' || json.sampleText.length > SAMPLE_MAX)) {
    return `sampleText must be a string of at most ${SAMPLE_MAX} chars`;
  }
  if ('licence' in json && (typeof json.licence !== 'string' || json.licence.length > LICENCE_MAX)) {
    return `licence must be a string of at most ${LICENCE_MAX} chars`;
  }
  if ('heavy' in json && typeof json.heavy !== 'boolean') return 'heavy must be a boolean';
  if ('pinFiles' in json) {
    const pf = json.pinFiles;
    if (!Array.isArray(pf) || pf.length > PIN_FILES_MAX) return `pinFiles must be an array of at most ${PIN_FILES_MAX} paths`;
    for (const f of pf) {
      if (typeof f !== 'string' || !f) return 'pinFiles items must be non-empty strings';
      if (path.isAbsolute(f) || path.posix.isAbsolute(f) || path.win32.isAbsolute(f)) return `pinFiles '${f}' must be project-relative, not absolute`;
      if (f.split(/[\\/]/).includes('..')) return `pinFiles '${f}' must not contain '..'`;
    }
  }
  return null;
}

/** -> { entry } | { error } | null (no file). */
function readEntryFile(file, scope) {
  if (!fs.existsSync(file)) return null;
  const stem = path.basename(file, '.json');
  let json;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_ENTRY_BYTES) return { error: `exceeds the ${MAX_ENTRY_BYTES}-byte limit` };
    json = JSON.parse(raw);
  } catch (e) {
    return { error: `not valid JSON: ${e.message}` };
  }
  const reason = validateVoiceEntry(json, stem);
  if (reason) return { error: reason };
  return {
    entry: {
      id: stem,
      label: json.label || stem,
      voice: json.voice,
      engine: json.voice.engine,
      sampleText: json.sampleText ?? DEFAULT_SAMPLE,
      licence: json.licence ?? 'unknown',
      heavy: json.heavy === true,
      ...(json.pinFiles ? { pinFiles: [...json.pinFiles] } : {}),
      scope,
      file,
    },
  };
}

function listDir(dir) {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function emptyApprovals() {
  return { version: 1, approvals: {} };
}

/** <voicesHome>/approvals.json; never throws (missing/corrupt = empty). */
function readApprovals() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(voicesHome(), 'approvals.json'), 'utf8'));
    if (!j || typeof j !== 'object' || !j.approvals || typeof j.approvals !== 'object' || Array.isArray(j.approvals)) return emptyApprovals();
    return { version: 1, approvals: j.approvals };
  } catch {
    return emptyApprovals();
  }
}

function approvalKey(scope, projectRoot, id) {
  return `${scope}|${scope === 'project' && projectRoot ? path.resolve(projectRoot) : ''}|${id}`;
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** sha256 of canonical {id, voice, pinFiles} + per pinFile sha256 of its bytes (or 'missing'). */
function pinOf(entry, projectRoot) {
  const pinFiles = Array.isArray(entry.pinFiles) ? entry.pinFiles : [];
  const h = crypto.createHash('sha256');
  h.update(canonical({ id: entry.id, voice: entry.voice, pinFiles }));
  for (const f of pinFiles) {
    let part = 'missing';
    try {
      if (projectRoot) part = sha256(fs.readFileSync(path.join(path.resolve(projectRoot), f)));
    } catch { /* missing */ }
    h.update(part);
  }
  return h.digest('hex');
}

function withApproval(entry, projectRoot, approvals) {
  const a = approvals.approvals[approvalKey(entry.scope, projectRoot, entry.id)];
  const approved = !!(a && typeof a === 'object');
  const pinOk = approved ? a.pin === pinOf(entry, projectRoot) : true;
  return { ...entry, approved, pinOk };
}

/** -> { voices, errors }: every library voice, highest scope wins per id. */
function listVoices(projectRoot) {
  const approvals = readApprovals();
  const errors = [];
  const byId = new Map();
  const add = (entry) => { if (!byId.has(entry.id)) byId.set(entry.id, entry); };
  for (const [scope, dir] of [['project', projectVoicesDir(projectRoot)], ['machine', machineVoicesDir()]]) {
    for (const file of listDir(dir)) {
      const r = readEntryFile(file, scope);
      if (!r) continue;
      if (r.error) errors.push({ file, error: r.error });
      else add(r.entry);
    }
  }
  for (const b of builtinVoices()) add(b);
  const voices = [...byId.values()]
    .map((e) => withApproval(e, projectRoot, approvals))
    .sort((a, b) => (SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { voices, errors };
}

/** -> { ok:true, entry, voice, scope, approved } | { ok:false, error }. */
function resolveVoiceId(projectRoot, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: `unknown voice '${id}'` };
  const approvals = readApprovals();
  let entry = null;
  for (const [scope, dir] of [['project', projectVoicesDir(projectRoot)], ['machine', machineVoicesDir()]]) {
    if (!dir) continue;
    const r = readEntryFile(path.join(dir, `${id}.json`), scope);
    if (r && r.error) return { ok: false, error: `voice '${id}' is invalid (${path.join(dir, `${id}.json`)}): ${r.error}` };
    if (r) { entry = r.entry; break; }
    if (approvals.approvals[approvalKey(scope, projectRoot, id)]) {
      return { ok: false, error: `approved voice '${id}' was removed outside the Voices screen` };
    }
  }
  if (!entry) entry = builtinVoices().find((b) => b.id === id) || null;
  if (!entry) return { ok: false, error: `unknown voice '${id}'` };
  const e = withApproval(entry, projectRoot, approvals);
  if (e.approved && !e.pinOk) {
    return { ok: false, error: `approved voice '${id}' changed since a human approved it; re-approve it in Project Home > Video > Voices` };
  }
  return { ok: true, entry: e, voice: e.voice, scope: e.scope, approved: e.approved };
}

module.exports = {
  voicesHome,
  listVoices,
  resolveVoiceId,
  pinOf,
  readApprovals,
  validateVoiceEntry,
  KOKORO_V1_VOICES,
};
