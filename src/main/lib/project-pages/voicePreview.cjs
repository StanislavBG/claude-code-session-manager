'use strict';

/**
 * voicePreview.cjs — the one preview path for a library voice (the Voices
 * screen and the MCP preview tool both call previewVoice).
 *
 * A clip is cached at <voicesHome>/cache/<previewKey>.wav, where previewKey is
 * the sha256 of voice id + trimmed text + canonical resolved voice JSON + the
 * approval pin (voiceLibrary.pinOf) — editing a voice's params or pin files
 * changes the key, so a stale clip is never served. A hit answers without
 * spawning anything.
 *
 * A miss runs the kit speak CLI (demo-video-kit/character.cjs speak <spec>)
 * as an ASYNC child (process.execPath + ELECTRON_RUN_AS_NODE=1, no shell), so
 * the main process never blocks and the preview waits in the same voice lane
 * as video runs. Exit 75 = still speaking: the same command is re-run until it
 * finishes or timeoutMs passes. Concurrent calls for one key share one run.
 * The cache keeps at most CACHE_MAX clips (oldest mtime removed).
 * Plain Node: no Electron import.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const voiceLibrary = require('../demo-video-kit/voiceLibrary.cjs');
const { cleanChildEnv } = require('../process/cleanEnv.cjs');

const CHARACTER_CJS = path.join(__dirname, '..', 'demo-video-kit', 'character.cjs');
const TEXT_MAX = 300;
const CACHE_MAX = 200;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const EXIT_PENDING = 75;
const RETRY_DELAY_MS = 200;
const OUTPUT_TAIL = 4000;

/** @type {Map<string, Promise<any>>} key -> in-flight preview */
const inFlight = new Map();

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** sha256 hex of voiceId, text, canonical resolved voice JSON and the approval pin. */
function previewKey({ voiceId, text, voice, pin }) {
  return crypto.createHash('sha256')
    .update(canonical({ voiceId: String(voiceId), text: String(text), voice: voice ?? null, pin: String(pin ?? '') }))
    .digest('hex');
}

const cacheDir = () => path.join(voiceLibrary.voicesHome(), 'cache');

/** Remove the oldest-mtime clips until at most CACHE_MAX remain; never throws. */
function pruneCache(dir, keep) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav') && !f.endsWith('.tmp.wav')).map((f) => {
      const p = path.join(dir, f);
      try { return { p, f, m: fs.statSync(p).mtimeMs }; } catch { return null; }
    }).filter(Boolean);
  } catch {
    return;
  }
  if (files.length <= CACHE_MAX) return;
  files.sort((a, b) => a.m - b.m);
  let excess = files.length - CACHE_MAX;
  for (const x of files) {
    if (excess <= 0) break;
    if (x.p === keep) continue;
    try { fs.rmSync(x.p, { force: true }); } catch { /* best effort */ }
    excess -= 1;
  }
}

/** One async run of the speak CLI -> {code, signal, stdout, stderr, error?}. */
function runOnce(specPath, cwd, killAfterMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...r });
    };
    let child;
    try {
      child = childProcess.spawn(process.execPath, [CHARACTER_CJS, 'speak', specPath], {
        cwd,
        env: cleanChildEnv({ ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      done({ code: null, signal: null, error: e.message });
      return;
    }
    child.stdout?.on('data', (d) => { stdout = (stdout + d).slice(-OUTPUT_TAIL); });
    child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-OUTPUT_TAIL); });
    child.on('error', (e) => done({ code: null, signal: null, error: e.message }));
    child.on('close', (code, signal) => done({ code, signal }));
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      done({ code: null, signal: 'SIGTERM', timedOut: true });
    }, Math.max(1, killAfterMs));
  });
}

/** The CLI's own error: its JSON result line's error, else stderr, else the exit. */
function cliError(r) {
  const last = String(r.stdout || '').trim().split('\n').pop() || '';
  try {
    const j = JSON.parse(last);
    if (j && typeof j.error === 'string' && j.error) return j.error;
  } catch { /* not JSON */ }
  const err = String(r.stderr || '').trim();
  if (err) return err;
  if (r.error) return r.error;
  return `speak CLI failed (${r.signal ? `killed by ${r.signal}` : `exit ${r.code}`})`;
}

async function synthesize({ root, voiceId, text, key, timeoutMs }) {
  const dir = cacheDir();
  const wavPath = path.join(dir, `${key}.wav`);
  const tmpOut = path.join(dir, `${key}.tmp.wav`);
  let specDir = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(tmpOut, { force: true });
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voice-preview-'));
    const specPath = path.join(specDir, 'spec.json');
    const spec = { projectRoot: root, voice: voiceId, kind: 'preview', label: `preview ${voiceId}`, lines: [{ text, out: tmpOut }] };
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, error: `voice preview for '${voiceId}' timed out after ${Math.round(timeoutMs / 1000)}s` };
      const r = await runOnce(specPath, root, left);
      if (r.timedOut) return { ok: false, error: `voice preview for '${voiceId}' timed out after ${Math.round(timeoutMs / 1000)}s` };
      if (r.code === EXIT_PENDING) {
        await new Promise((res) => setTimeout(res, Math.min(RETRY_DELAY_MS, Math.max(0, deadline - Date.now()))));
        continue;
      }
      if (r.code !== 0) return { ok: false, error: cliError(r) };
      if (!fs.existsSync(tmpOut)) return { ok: false, error: `speak CLI exited 0 but wrote no clip to ${tmpOut}` };
      fs.renameSync(tmpOut, wavPath);
      pruneCache(dir, wavPath);
      return { ok: true, cached: false, wavPath, bytes: fs.readFileSync(wavPath) };
    }
  } catch (e) {
    return { ok: false, error: `voice preview failed: ${e && e.message ? e.message : String(e)}` };
  } finally {
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* best effort */ }
    if (specDir) {
      try { require('../demo-video-kit/resumableRun.cjs').stopRun(path.join(specDir, 'spec.json.run')); } catch { /* none */ }
      try { fs.rmSync(specDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Preview one library voice speaking `text`.
 * -> {ok:true, cached, wavPath, bytes: Buffer} | {ok:false, error}
 * @param {{ projectRoot?: string, voiceId: string, text: string, timeoutMs?: number }} args
 */
async function previewVoice({ projectRoot, voiceId, text, timeoutMs } = /** @type {any} */ ({})) {
  if (!projectRoot || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    return { ok: false, error: 'projectRoot must be an absolute path' };
  }
  const root = path.resolve(projectRoot);
  const t = typeof text === 'string' ? text.trim() : '';
  if (t.length < 1 || t.length > TEXT_MAX) return { ok: false, error: `text must be 1-${TEXT_MAX} chars after trimming` };
  const rv = voiceLibrary.resolveVoiceId(root, voiceId);
  if (!rv.ok) return { ok: false, error: rv.error };
  const key = previewKey({ voiceId, text: t, voice: rv.voice, pin: voiceLibrary.pinOf(rv.entry, root) });
  const wavPath = path.join(cacheDir(), `${key}.wav`);
  try {
    const bytes = fs.readFileSync(wavPath);
    try { const now = new Date(); fs.utimesSync(wavPath, now, now); } catch { /* best effort */ }
    return { ok: true, cached: true, wavPath, bytes };
  } catch { /* miss */ }
  const running = inFlight.get(key);
  if (running) return running;
  const ms = Number.isFinite(timeoutMs) && /** @type {number} */ (timeoutMs) > 0 ? /** @type {number} */ (timeoutMs) : DEFAULT_TIMEOUT_MS;
  const p = synthesize({ root, voiceId, text: t, key, timeoutMs: ms }).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

module.exports = { previewVoice, previewKey, CACHE_MAX, TEXT_MAX, DEFAULT_TIMEOUT_MS };
