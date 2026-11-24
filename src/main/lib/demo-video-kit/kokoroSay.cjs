/**
 * kokoroSay.cjs — speak Kokoro-82M (kokoro-onnx) voices from the kit itself.
 *
 * One spawnSync of python loads the model ONCE and writes one WAV per line, so
 * a voice preview and a full video run go through the same code (and the same
 * voice lane). Node built-ins only: this file is copied into the per-machine
 * kit folder by seedKit.cjs and required from any project's cwd.
 *
 *   const { sayKokoro } = require('<kit>/kokoroSay.cjs');
 *   sayKokoro([{ text: 'Hello.', out: 'a.wav', voice: 'af_heart' }], { cwd })
 *     -> { ok: true, outs: [abs...], audioSeconds, seconds: [...] } | { ok: false, error }
 *
 * python: opts.python, else $SM_KOKORO_PYTHON, else python3 (argv ['-c', KOKORO_SCRIPT],
 * JSON {modelDir, lines} on stdin, no shell). Model dir: opts.modelDir, else
 * $KOKORO_MODEL_DIR, else ~/.cache/kokoro-onnx.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MODEL_FILE = 'kokoro-v1.0.onnx';
const VOICES_FILE = 'voices-v1.0.bin';
const MODEL_URL_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const PIP_INSTALL = 'python3 -m pip install --user --break-system-packages kokoro-onnx soundfile';
const WAV_HEADER_BYTES = 44;
const STDERR_TAIL = 500;
const PER_LINE_TIMEOUT_MS = 15 * 60 * 1000;
const TIMEOUT_CAP_MS = 180 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const DEFAULT_LANG = 'en-us';

/** Python source run as `python -c KOKORO_SCRIPT`; reads {modelDir, lines} JSON from stdin. */
const KOKORO_SCRIPT = `
import json, sys
def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.stdout.flush()
    sys.exit(1)
try:
    req = json.loads(sys.stdin.read())
except Exception as e:
    fail("bad request JSON on stdin: %s" % e)
try:
    import soundfile
    from kokoro_onnx import Kokoro
except Exception as e:
    fail("import failed (%s: %s); install with: ${PIP_INSTALL}" % (type(e).__name__, e))
try:
    d = req["modelDir"]
    k = Kokoro(d + "/${MODEL_FILE}", d + "/${VOICES_FILE}")
    seconds = []
    for ln in req["lines"]:
        samples, sr = k.create(ln["text"], voice=ln["voice"], speed=float(ln["speed"]), lang=ln["lang"])
        soundfile.write(ln["out"], samples, sr)
        seconds.append(round(len(samples) / float(sr), 3))
    print(json.dumps({"ok": True, "seconds": seconds}))
except Exception as e:
    fail("%s: %s" % (type(e).__name__, e))
`;

function curlCommand(modelDir, file) {
  return `curl -L --max-time 600 -o "${path.join(modelDir, file)}" ${MODEL_URL_BASE}/${file}`;
}

function resolveModelDir(opts, env) {
  if (opts.modelDir) return path.resolve(String(opts.modelDir));
  if (env.KOKORO_MODEL_DIR) return path.resolve(env.KOKORO_MODEL_DIR);
  return path.join(os.homedir(), '.cache', 'kokoro-onnx');
}

/** -> {ok: true, lines: normalized[]} | {ok: false, error}. Pure (no fs). */
function validateLines(lines, cwd) {
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: 'lines must be a non-empty array' };
  const seen = new Map();
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const at = `lines[${i}]`;
    if (!ln || typeof ln !== 'object') return { ok: false, error: `${at} must be an object {text, out, voice, speed?, lang?}` };
    if (typeof ln.text !== 'string' || !ln.text.trim()) return { ok: false, error: `${at}.text must be a non-empty string` };
    if (typeof ln.out !== 'string' || !ln.out.trim() || !ln.out.toLowerCase().endsWith('.wav')) {
      return { ok: false, error: `${at}.out must be a path ending in .wav` };
    }
    if (typeof ln.voice !== 'string' || !ln.voice.trim()) return { ok: false, error: `${at}.voice must be a non-empty string` };
    let speed = 1.0;
    if (ln.speed !== undefined && ln.speed !== null) {
      speed = ln.speed;
      if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < SPEED_MIN || speed > SPEED_MAX) {
        return { ok: false, error: `${at}.speed must be a number from ${SPEED_MIN} to ${SPEED_MAX}` };
      }
    }
    let lang = DEFAULT_LANG;
    if (ln.lang !== undefined && ln.lang !== null) {
      if (typeof ln.lang !== 'string' || !ln.lang.trim()) return { ok: false, error: `${at}.lang must be a non-empty string` };
      lang = ln.lang.trim();
    }
    const abs = path.resolve(cwd, ln.out);
    if (seen.has(abs)) return { ok: false, error: `${at}.out duplicates lines[${seen.get(abs)}].out (${abs})` };
    seen.set(abs, i);
    out.push({ text: ln.text, out: abs, voice: ln.voice.trim(), speed, lang });
  }
  return { ok: true, lines: out };
}

function timeoutFor(lineCount, timeoutMs) {
  const base = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : lineCount * PER_LINE_TIMEOUT_MS;
  return Math.min(base, TIMEOUT_CAP_MS);
}

function parseLastJsonLine(stdout) {
  const rows = String(stdout || '').trim().split('\n').reverse();
  for (const row of rows) {
    try {
      const v = JSON.parse(row);
      if (v && typeof v === 'object') return v;
    } catch { /* not JSON */ }
  }
  return null;
}

function isWav(p) {
  try {
    return fs.statSync(p).size > WAV_HEADER_BYTES;
  } catch {
    return false;
  }
}

/**
 * Speak `lines` with Kokoro in ONE python process.
 * opts: {python, modelDir, cwd, timeoutMs, env}
 * -> {ok: true, outs, audioSeconds, seconds} | {ok: false, error}
 */
function sayKokoro(lines, opts = {}) {
  const env = opts.env || process.env;
  const cwd = path.resolve(opts.cwd || process.cwd());
  const v = validateLines(lines, cwd);
  if (!v.ok) return v;

  const modelDir = resolveModelDir(opts, env);
  for (const f of [MODEL_FILE, VOICES_FILE]) {
    if (!fs.existsSync(path.join(modelDir, f))) {
      return { ok: false, error: `Kokoro model file ${f} is missing from ${modelDir}; download it with: ${curlCommand(modelDir, f)}` };
    }
  }

  try {
    for (const ln of v.lines) {
      fs.mkdirSync(path.dirname(ln.out), { recursive: true });
      fs.rmSync(ln.out, { force: true }); // a stale WAV must never count as this run's output
    }
  } catch (e) {
    return { ok: false, error: `cannot prepare output paths: ${e.message}` };
  }

  const python = opts.python || env.SM_KOKORO_PYTHON || 'python3';
  const limit = timeoutFor(v.lines.length, opts.timeoutMs);
  const r = spawnSync(python, ['-c', KOKORO_SCRIPT], {
    shell: false,
    cwd,
    env,
    input: JSON.stringify({ modelDir, lines: v.lines }),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: limit,
    maxBuffer: MAX_BUFFER,
  });
  const stderr = r.stderr ? r.stderr.toString('utf8').trim().slice(-STDERR_TAIL) : '';
  const withStderr = (msg) => (stderr ? `${msg}: ${stderr}` : msg);
  const result = parseLastJsonLine(r.stdout ? r.stdout.toString('utf8') : '');

  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') return { ok: false, error: withStderr(`Kokoro timed out after ${limit} ms`) };
    return { ok: false, error: withStderr(`cannot run ${python}: ${r.error.message}`) };
  }
  if (r.status !== 0) {
    const why = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    let msg = result && result.ok === false && result.error ? `Kokoro failed (${why}): ${result.error}` : `Kokoro failed (${why})`;
    if (/ModuleNotFoundError|ImportError|No module named/.test(stderr) && !msg.includes(PIP_INSTALL)) {
      msg += `; install with: ${PIP_INSTALL}`;
    }
    return { ok: false, error: withStderr(msg) };
  }
  const missing = v.lines.filter((ln) => !isWav(ln.out)).map((ln) => ln.out);
  if (missing.length) return { ok: false, error: withStderr(`Kokoro wrote no WAV to ${missing.join(', ')}`) };

  const seconds = result && Array.isArray(result.seconds) ? result.seconds.map(Number) : [];
  const audioSeconds = Math.round(seconds.reduce((a, s) => a + (Number.isFinite(s) ? s : 0), 0) * 1000) / 1000;
  return { ok: true, outs: v.lines.map((ln) => ln.out), audioSeconds, seconds };
}

module.exports = {
  sayKokoro,
  KOKORO_SCRIPT,
  validateLines,
  MODEL_FILE,
  VOICES_FILE,
  PIP_INSTALL,
  PER_LINE_TIMEOUT_MS,
  TIMEOUT_CAP_MS,
};
