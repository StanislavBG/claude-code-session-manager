'use strict';
// Demo-video kit sound helper: synthesized royalty-free music bed, small SFX set,
// ducked mix under narration, and two-pass ffmpeg loudnorm (-14 LUFS / -1.5 dBTP).
// Node builtins only; ffmpeg is spawned without a shell and every call has a timeout.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SR = 44100;
const FFMPEG = process.env.SM_FFMPEG || 'ffmpeg';
const FFMPEG_TIMEOUT_MS = 120000;
const TARGET = { I: -14, TP: -1.5, LRA: 11 };
const DUCK_DB = 4;
const BED_BASE_DB = -16; // bed level under silence, relative to full scale before loudnorm

// Style presets: tempo, root (Hz), chord progression as semitone triads, timbre, pulse.
const STYLES = {
  Professional: { bpm: 84, root: 130.81, prog: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]], pad: 0.5, bass: 0.35, pulse: 0, pluck: 0.15, bright: 0.2 },
  Fun: { bpm: 118, root: 196.0, prog: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], pad: 0.25, bass: 0.35, pulse: 0.5, pluck: 0.45, bright: 0.6 },
  'Animated whiteboard': { bpm: 100, root: 174.61, prog: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]], pad: 0.3, bass: 0.3, pulse: 0.25, pluck: 0.5, bright: 0.45 },
  'Kinetic typography': { bpm: 124, root: 146.83, prog: [[0, 3, 7], [8, 12, 15], [5, 8, 12], [10, 14, 17]], pad: 0.25, bass: 0.5, pulse: 0.6, pluck: 0.3, bright: 0.5 },
};

function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const semi = (root, n) => root * Math.pow(2, n / 12);
const dbToGain = (db) => Math.pow(10, db / 20);

/** Wrap mono Float32 samples in a WAV (IEEE float, format 3). */
function encodeWav(samples, sr = SR) {
  const dataBytes = samples.length * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeFloatLE(samples[i], 44 + i * 4);
  return buf;
}

/** Read a mono 32-bit float WAV into Float32Array. */
function decodeWavF32(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(body), ch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt || fmt.tag !== 3 || fmt.bits !== 32 || fmt.ch !== 1) throw new Error('expected mono float32 WAV');
      size = Math.min(size, buf.length - body);
      const n = Math.floor(size / 4);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(body + i * 4);
      return out;
    }
    pos = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

function softClipPeak(x, peak) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  if (m > 0) { const g = peak / m; for (let i = 0; i < x.length; i++) x[i] *= g; }
}

function bedSamples({ style, lengthS, seed }) {
  const p = STYLES[style];
  if (!p) throw new Error(`unknown style: ${style} (expected one of ${Object.keys(STYLES).join(', ')})`);
  const n = Math.max(1, Math.round(Number(lengthS) * SR));
  const rnd = mulberry32(seed);
  const out = new Float32Array(n);
  const beat = 60 / p.bpm;
  const barS = beat * 4;
  // Seed picks a transposition and a pluck pattern so different seeds give different beds.
  const transpose = Math.floor(rnd() * 5) - 2;
  const pattern = Array.from({ length: 8 }, () => rnd() < 0.7);
  const arpPick = Array.from({ length: 8 }, () => Math.floor(rnd() * 3));
  const root = semi(p.root, transpose);
  const TAU = 2 * Math.PI;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bar = Math.floor(t / barS);
    const chord = p.prog[bar % p.prog.length];
    const tb = t - bar * barS; // time inside bar
    // Pad: detuned sines with slow swell per bar.
    // Clamp: at a bar boundary float rounding can make tb ≈ -1e-15, and a negative base ** 0.5 is NaN.
    const swell = Math.max(0, Math.sin(Math.PI * Math.min(1, tb / barS))) ** 0.5;
    let v = 0;
    for (const st of chord) {
      const f = semi(root, st);
      v += p.pad * swell * (Math.sin(TAU * f * t) + Math.sin(TAU * f * 1.004 * t) * 0.6 + p.bright * 0.3 * Math.sin(TAU * f * 2 * t)) / 3;
    }
    // Bass on beats 1 and 3 of each bar.
    const bf = semi(root, chord[0]) / 2;
    const bt = tb % (beat * 2);
    v += p.bass * Math.sin(TAU * bf * t) * Math.exp(-bt * 2.2) * 0.9;
    // Eighth-note pluck arpeggio.
    const eighth = beat / 2;
    const step = Math.floor(tb / eighth);
    if (p.pluck > 0 && pattern[step % 8]) {
      const et = tb - step * eighth;
      const pf = semi(root, chord[arpPick[step % 8]] + 12);
      v += p.pluck * 0.5 * Math.sin(TAU * pf * t) * Math.exp(-et * 9);
    }
    // Soft pulse: kick-like thump on every beat.
    if (p.pulse > 0) {
      const kt = tb % beat;
      v += p.pulse * 0.5 * Math.sin(TAU * (55 + 90 * Math.exp(-kt * 30)) * kt) * Math.exp(-kt * 10);
    }
    out[i] = v;
  }
  softClipPeak(out, 0.8);
  // Fade in/out so the bed never clicks at the edges.
  const fade = Math.min(Math.round(1.0 * SR), Math.floor(n / 2));
  for (let i = 0; i < fade; i++) { const g = i / fade; out[i] *= g; out[n - 1 - i] *= g; }
  return out;
}

/** Deterministic Float32 PCM WAV (mono, 44.1 kHz) music bed. */
function buildMusicBed({ style, lengthS, seed = 1 }) {
  return encodeWav(bedSamples({ style, lengthS, seed }));
}

const SFX_NAMES = ['whoosh', 'pop', 'chime', 'click'];

function sfxSamples(name) {
  if (!SFX_NAMES.includes(name)) throw new Error(`unknown sfx: ${name} (expected one of ${SFX_NAMES.join(', ')})`);
  const TAU = 2 * Math.PI;
  const rnd = mulberry32(0x5f3759df);
  let durS;
  switch (name) {
    case 'whoosh': durS = 0.6; break;
    case 'pop': durS = 0.15; break;
    case 'chime': durS = 1.2; break;
    default: durS = 0.05;
  }
  const n = Math.round(durS * SR);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const x = t / durS;
    if (name === 'whoosh') {
      // Noise through a sweeping one-pole low-pass, bell-shaped envelope.
      const a = 0.02 + 0.5 * Math.sin(Math.PI * x);
      lp += a * ((rnd() * 2 - 1) - lp);
      out[i] = lp * Math.sin(Math.PI * x) ** 2 * 1.6;
    } else if (name === 'pop') {
      out[i] = Math.sin(TAU * (180 + 520 * Math.exp(-t * 60)) * t) * Math.exp(-t * 28);
    } else if (name === 'chime') {
      let v = 0;
      [[880, 1], [1318.5, 0.5], [1760, 0.3], [2637, 0.12]].forEach(([f, amp]) => { v += amp * Math.sin(TAU * f * t); });
      out[i] = v * Math.exp(-t * 4) * Math.min(1, t * 400) * 0.45;
    } else {
      out[i] = ((rnd() * 2 - 1) * 0.6 + Math.sin(TAU * 2400 * t) * 0.4) * Math.exp(-t * 110);
    }
  }
  softClipPeak(out, 0.7);
  return out;
}

/** SFX as Float32 WAV. name: whoosh | pop | chime | click. */
function buildSfx(name) {
  return encodeWav(sfxSamples(name));
}

function runFfmpeg(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, shell: false });
  if (r.error) throw new Error(`ffmpeg failed to run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}: ${String(r.stderr).slice(-600)}`);
  return String(r.stderr || '');
}

/** Parse ffmpeg `ebur128=peak=true` summary into {lufs, truePeakDb}. */
function parseEbur128(text) {
  const s = String(text);
  const i = s.lastIndexOf('Summary:');
  const tail = i >= 0 ? s.slice(i) : s;
  const num = (m) => (m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : null);
  const lufs = num(/Integrated loudness:\s*I:\s*(-?inf|-?[\d.]+)\s*LUFS/.exec(tail));
  const truePeakDb = num(/True peak:\s*Peak:\s*(-?inf|-?[\d.]+)\s*dBFS/.exec(tail));
  if (lufs === null || truePeakDb === null) throw new Error('could not parse ebur128 output');
  return { lufs, truePeakDb };
}

/** Measure integrated loudness and true peak of an audio/video file. */
function measure(file) {
  const err = runFfmpeg(['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  return parseEbur128(err);
}

/** Two-pass loudnorm of `input` into `output` at I=-14 TP=-1.5 LRA=11. */
function loudnorm(input, output) {
  const base = `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}`;
  const err1 = runFfmpeg(['-hide_banner', '-nostats', '-i', input, '-af', `${base}:print_format=json`, '-f', 'null', '-']);
  const j = err1.slice(err1.lastIndexOf('{'), err1.lastIndexOf('}') + 1);
  let m;
  try { m = JSON.parse(j); } catch { throw new Error('could not parse loudnorm pass-1 output'); }
  const f = (k) => {
    const v = Number(m[k]);
    if (!Number.isFinite(v)) throw new Error(`loudnorm pass-1 missing ${k}`);
    return v;
  };
  const pass2 = `${base}:measured_I=${f('input_i')}:measured_TP=${f('input_tp')}:measured_LRA=${f('input_lra')}:measured_thresh=${f('input_thresh')}:offset=${f('target_offset')}:linear=true:print_format=summary`;
  const codec = /\.wav$/i.test(output) ? ['-c:a', 'pcm_s16le'] : [];
  runFfmpeg(['-hide_banner', '-nostats', '-y', '-i', input, '-af', pass2, '-ar', String(SR), ...codec, output]);
}

/** Per-sample gain (1 → -DUCK_DB) following speech activity; returns {gain, speechS}. */
function duckEnvelope(narr) {
  const win = Math.round(0.02 * SR);
  const nWin = Math.ceil(narr.length / win);
  const speech = new Uint8Array(nWin);
  let active = 0;
  for (let w = 0; w < nWin; w++) {
    let e = 0;
    const end = Math.min(narr.length, (w + 1) * win);
    for (let i = w * win; i < end; i++) e += narr[i] * narr[i];
    const rms = Math.sqrt(e / Math.max(1, end - w * win));
    if (rms > 0.01) { speech[w] = 1; active++; }
  }
  const hold = 15; // 300 ms hold bridges gaps between words
  const target = new Float32Array(nWin).fill(1);
  const low = dbToGain(-DUCK_DB);
  let since = hold + 1;
  for (let w = 0; w < nWin; w++) {
    since = speech[w] ? 0 : since + 1;
    if (since <= hold) target[w] = low;
  }
  const gain = new Float32Array(narr.length);
  const atk = 1 - Math.exp(-1 / (0.05 * SR));
  const rel = 1 - Math.exp(-1 / (0.3 * SR));
  let g = 1;
  for (let i = 0; i < narr.length; i++) {
    const tg = target[Math.min(nWin - 1, Math.floor(i / win))];
    g += (tg < g ? atk : rel) * (tg - g);
    gain[i] = g;
  }
  return { gain, speechS: active * 0.02 };
}

/** Decode any audio file to mono 44.1 kHz float samples (non-finite samples -> 0). */
function decodeMono(file, dir, tag) {
  const f32 = path.join(dir, `${tag}.f32.wav`);
  runFfmpeg(['-hide_banner', '-nostats', '-y', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_f32le', f32]);
  const x = decodeWavF32(fs.readFileSync(f32));
  // A single NaN in the buffer handed to ffmpeg makes libmp3lame assert (0-byte mp3).
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) x[i] = 0;
  return x;
}

const BUILTIN_LIST = SFX_NAMES.join(', ');

// Mutable so a test can shorten the limit; production never changes it.
const BED_COMMAND_LIMITS = { timeoutMs: 300000 };
const BED_STDERR_TAIL = 500;

/** Lazy, memoised persona reader for the cue/bed pre-pass; throws when character.json exists but is unusable. */
function personaLoader(projectRoot) {
  let persona;
  return () => {
    if (persona === undefined) {
      const { inspectCharacter } = require('./character.cjs');
      persona = inspectCharacter(projectRoot);
      if (!persona.ok && persona.exists) throw new Error(`project persona unusable: ${persona.error}`);
    }
    return persona;
  };
}

const hasRoot = (projectRoot) => projectRoot !== undefined && projectRoot !== null;

/**
 * Resolve every cue name before any audio work: built-ins map to null, a persona
 * sounds.sfx name to its WAV path. Throws a named reason for anything else.
 * The persona is read only when some cue is not built-in.
 */
function resolveCueFiles(cues, projectRoot, getPersona) {
  const files = new Map();
  for (const cue of cues) {
    const name = cue && cue.name;
    if (SFX_NAMES.includes(name) || files.has(name)) continue;
    if (!hasRoot(projectRoot)) {
      throw new Error(`unknown sfx: ${name} (built-in: ${BUILTIN_LIST}; pass projectRoot to use the persona's own sounds)`);
    }
    const { findProjectSound, soundFile, checkSoundWav } = require('./projectSounds.cjs');
    const persona = getPersona();
    const found = persona.ok ? findProjectSound(persona.json, name) : null;
    if (!found || found.kind !== 'sfx') {
      const s = persona.ok && persona.json.sounds && Array.isArray(persona.json.sounds.sfx) ? persona.json.sounds.sfx : [];
      const names = s.map((e) => e && e.name).filter((n) => typeof n === 'string').join(', ');
      throw new Error(`unknown sfx: ${name} (built-in: ${BUILTIN_LIST}; persona sounds.sfx: ${names || 'none'})`);
    }
    const file = soundFile(projectRoot, name);
    if (!fs.existsSync(file)) {
      throw new Error(`project sfx '${name}' has no WAV at ${file} (save the persona again with its sound files)`);
    }
    const reason = checkSoundWav(fs.readFileSync(file), `project sfx '${name}' (${file})`, 'sfx');
    if (reason) throw new Error(reason);
    files.set(name, file);
  }
  return files;
}

/**
 * Resolve spec.bed before any audio work -> {style} for a built-in bed, {name, file}
 * for a file-backed persona bed, {name, command} for a command bed. Throws a named reason.
 */
function resolveBed(bed, style, projectRoot, getPersona) {
  if (bed === undefined || bed === null) return { style };
  if (Object.prototype.hasOwnProperty.call(STYLES, bed)) return { style: bed };
  const styles = Object.keys(STYLES).join(', ');
  if (!hasRoot(projectRoot)) {
    throw new Error(`unknown bed: ${bed} (built-in styles: ${styles}; pass projectRoot to use the persona's own beds)`);
  }
  const { findProjectSound, soundFile, checkSoundWav } = require('./projectSounds.cjs');
  const persona = getPersona();
  const found = persona.ok ? findProjectSound(persona.json, bed) : null;
  if (!found || found.kind !== 'bed') {
    const b = persona.ok && persona.json.sounds && Array.isArray(persona.json.sounds.beds) ? persona.json.sounds.beds : [];
    const names = b.map((e) => e && e.name).filter((n) => typeof n === 'string').join(', ');
    throw new Error(`unknown bed: ${bed} (built-in styles: ${styles}; persona sounds.beds: ${names || 'none'})`);
  }
  const name = bed;
  if (Array.isArray(found.entry.command)) return { name, command: [...found.entry.command] };
  const file = soundFile(projectRoot, name);
  if (!fs.existsSync(file)) {
    throw new Error(`project bed '${name}' has no WAV at ${file} (save the persona again with its sound files)`);
  }
  const reason = checkSoundWav(fs.readFileSync(file), `project bed '${name}' (${file})`, 'bed');
  if (reason) throw new Error(reason);
  return { name, file };
}

/** A file bed looped end to end to n samples with bedSamples' edge fades. */
function loopFileBed(file, dir, n) {
  const s = decodeMono(file, dir, 'bed');
  const out = new Float32Array(n);
  if (s.length > 0) for (let i = 0; i < n; i++) out[i] = s[i % s.length];
  const fade = Math.min(Math.round(1.0 * SR), Math.floor(n / 2));
  for (let i = 0; i < fade; i++) { const g = i / fade; out[i] *= g; out[n - 1 - i] *= g; }
  return out;
}

/** Render a command bed of n samples via the project's own command (no shell, cwd = projectRoot). */
function renderCommandBed({ name, command }, { dir, n, seed, projectRoot }) {
  const { wavFormatError } = require('./projectSounds.cjs');
  const outWav = path.join(dir, `bed-${name}.wav`);
  const lengthS = (n / SR).toFixed(3);
  const subs = { '{name}': name, '{lengthS}': lengthS, '{seed}': String(seed), '{out}': outWav };
  const argv = command.map((a) => {
    let v = a;
    for (const [k, val] of Object.entries(subs)) v = v.split(k).join(val);
    return v;
  });
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: projectRoot,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: BED_COMMAND_LIMITS.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderr = r.stderr ? r.stderr.toString('utf8').trim().slice(-BED_STDERR_TAIL) : '';
  const withStderr = (msg) => (stderr ? `${msg}: ${stderr}` : msg);
  const label = `project bed '${name}' command`;
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(withStderr(`${label} killed at its ${BED_COMMAND_LIMITS.timeoutMs / 1000} s limit`));
  if (r.error) throw new Error(withStderr(`${label} failed to run: ${r.error.message}`));
  if (r.status !== 0) {
    const why = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    throw new Error(withStderr(`${label} failed (${why})`));
  }
  if (!fs.existsSync(outWav)) throw new Error(withStderr(`${label} wrote no WAV to ${outWav}`));
  const reason = wavFormatError(fs.readFileSync(outWav), `${label} output (${outWav})`);
  if (reason) throw new Error(reason);
  const s = decodeMono(outWav, dir, 'bed');
  if (s.length < Math.round((n / SR - 0.05) * SR)) {
    throw new Error(`${label} wrote ${(s.length / SR).toFixed(3)} s of audio; the mix needs at least ${(n / SR - 0.05).toFixed(3)} s (${lengthS} s less the 0.05 s tolerance)`);
  }
  if (s.length >= n) return s.subarray(0, n);
  const out = new Float32Array(n);
  out.set(s);
  return out;
}

/**
 * Mix narration + ducked music bed + SFX cues, then loudnorm to -14 LUFS / -1.5 dBTP.
 * cues: [{name, t}] (t in seconds; `at` also accepted). A name that is not a built-in
 * effect is read from the persona's sounds.sfx under projectRoot (absolute).
 * bed: absent -> the style's built-in bed; a STYLES key -> that built-in bed; any other
 * name -> the persona's sounds.beds entry (a WAV looped to length, or rendered by its
 * command). Output length is the longer of lengthS and the narration.
 * Returns {lufs, truePeakDb, speechS}.
 */
function mix({ narrationWav, cues = [], style, bed: bedName, lengthS, out, seed = 1, projectRoot }) {
  if (hasRoot(projectRoot) && (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot))) {
    throw new Error('spec.projectRoot must be an absolute path');
  }
  const getPersona = personaLoader(projectRoot);
  const cueFiles = resolveCueFiles(cues, projectRoot, getPersona);
  const bedSpec = resolveBed(bedName, style, projectRoot, getPersona);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dvk-sound-'));
  try {
    const narr = decodeMono(narrationWav, dir, 'narration');
    const n = Math.max(narr.length, Math.round(Number(lengthS) * SR));
    let bed;
    if (bedSpec.file) bed = loopFileBed(bedSpec.file, dir, n);
    else if (bedSpec.command) bed = renderCommandBed(bedSpec, { dir, n, seed, projectRoot });
    else bed = bedSamples({ style: bedSpec.style, lengthS: n / SR, seed });
    // A single NaN in the buffer handed to ffmpeg makes libmp3lame assert (0-byte mp3).
    for (let i = 0; i < bed.length; i++) if (!Number.isFinite(bed[i])) bed[i] = 0;
    const projectSfx = new Map();
    let k = 0;
    for (const [name, file] of cueFiles) projectSfx.set(name, decodeMono(file, dir, `sfx-${k++}`));
    const { gain, speechS } = duckEnvelope(narr);
    const bedGain = dbToGain(BED_BASE_DB);
    const mixed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = i < gain.length ? gain[i] : 1;
      mixed[i] = (i < narr.length ? narr[i] : 0) + bed[i] * bedGain * g;
    }
    const sfxGain = dbToGain(-10);
    for (const cue of cues) {
      const at = Math.round(Number(cue.t ?? cue.at ?? 0) * SR);
      const s = projectSfx.get(cue.name) || sfxSamples(cue.name);
      for (let i = 0; i < s.length && at + i < n; i++) if (at + i >= 0) mixed[at + i] += s[i] * sfxGain;
    }
    const pre = path.join(dir, 'premix.f32.wav');
    fs.writeFileSync(pre, encodeWav(mixed));
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    loudnorm(pre, out);
    return { ...measure(out), speechS };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { buildMusicBed, buildSfx, mix, measure, parseEbur128, runFfmpeg, decodeWavF32, STYLES, SFX_NAMES, TARGET, BED_COMMAND_LIMITS };

if (require.main === module) {
  try {
    const specPath = process.argv[2];
    if (!specPath) throw new Error('usage: node sound.cjs <spec.json>');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const r = mix(spec);
    process.stdout.write(JSON.stringify({ lufs: r.lufs, truePeakDb: r.truePeakDb, speechS: r.speechS }) + '\n');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
