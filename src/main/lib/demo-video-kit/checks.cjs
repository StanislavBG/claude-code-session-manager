'use strict';
// Pure, dependency-free analyzers a demo-video builder must pass before saving.
// Node builtins only: this folder is copied to ~/.claude/session-manager/demo-video-kit/.
// Each check returns {id, ok, detail}. CLI: node checks.cjs <input.json> -> JSON, exit 1 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BANNED_WORDS = Object.freeze([
  'MCP', 'API', 'SDK', 'CLI', 'repo', 'cron', 'pipeline', 'automation', 'npm', 'pnpm', 'deploy',
  'backend', 'frontend', 'local-first', 'headless', 'leverage', 'utilize', 'seamless', 'robust',
  'facilitate', 'sign up now', "don't miss", 'game-changer', 'revolutionary', 'unlock', 'level up',
  'supercharge', 'best-in-class', 'world-class', 'cutting-edge', 'limited time', 'act now',
  'buy now', 'skyrocket', 'must-have',
]);

const MAX_CAPTION_WORDS = 12;
const MAX_SENTENCE_WORDS = 14;
const MAX_GRADE = 8;
const VOICE_FIT_RATIO = 1.2;
const MIN_SPEECH_COVERAGE = 0.4;
const BLANK_AFTER_S = 0.5;
const DEFAULT_BLANK_STDDEV = 3;
const HTML_MB_PER_30S = 2 * 1024 * 1024;
const MIN_SPEECH_MODULATION = 0.2;
const ENVELOPE_WINDOW_S = 0.02;
const DECODE_SR = 16000;

const result = (id, ok, detail) => ({ id, ok: !!ok, detail });
const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Syllable heuristic: count vowel groups (aeiouy), drop a trailing silent "e"
// (but not "-le"), minimum 1 per word. Approximate, good enough for grade lint.
function countSyllables(word) {
  let w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length > 2 && /e$/.test(w) && !/[aeiouy]le$/.test(w) && !/[^aeiouy]le$/.test(w)) w = w.slice(0, -1);
  const groups = w.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 0);
}

function splitSentences(text) {
  return String(text || '').split(/[.!?]+(?:\s+|$)|\n+/).map((s) => s.trim()).filter((s) => words(s).length);
}

function checkCaptions(captions) {
  const list = Array.isArray(captions) ? captions : [];
  const bad = list.map((c, i) => ({ i, n: words(c).length })).filter((x) => x.n > MAX_CAPTION_WORDS);
  return result('captions', bad.length === 0,
    bad.length ? `caption(s) over ${MAX_CAPTION_WORDS} words: ${bad.map((b) => `#${b.i + 1} (${b.n})`).join(', ')}`
      : `${list.length} caption(s) within ${MAX_CAPTION_WORDS} words`);
}

function findBanned(text) {
  const t = String(text || '');
  return BANNED_WORDS.filter((b) => new RegExp(`(?<![A-Za-z0-9])${escRe(b)}(?![A-Za-z0-9])`, 'i').test(t));
}

function lintLanguage(text) {
  const t = Array.isArray(text) ? text.join('. ') : String(text || '');
  const problems = [];
  const sentences = splitSentences(t);
  const ws = words(t);
  const long = sentences.filter((s) => words(s).length > MAX_SENTENCE_WORDS);
  if (long.length) problems.push(`${long.length} sentence(s) over ${MAX_SENTENCE_WORDS} words`);
  let grade = 0;
  if (ws.length && sentences.length) {
    const syl = ws.reduce((n, w) => n + countSyllables(w), 0);
    grade = 0.39 * (ws.length / sentences.length) + 11.8 * (syl / ws.length) - 15.59;
    if (grade > MAX_GRADE) problems.push(`Flesch-Kincaid grade ${grade.toFixed(1)} > ${MAX_GRADE}`);
  }
  const banned = findBanned(t);
  if (banned.length) problems.push(`banned: ${banned.join(', ')}`);
  return result('language', problems.length === 0,
    problems.length ? problems.join('; ') : `grade ${grade.toFixed(1)}, sentences <= ${MAX_SENTENCE_WORDS} words, no banned words`);
}

const SHELL_CMD = /(?<![A-Za-z0-9-])(npm|npx|pnpm|yarn|git|curl|wget|pip|pip3|brew|sudo|apt|docker)\s+[A-Za-z-]/i;
function checkClosing(closing) {
  const t = String(closing || '');
  const lead = /^\s*\$/.test(t) || /(^|\n)\s*\$\s/.test(t);
  const m = t.match(SHELL_CMD);
  const ok = !lead && !m;
  return result('closing', ok, ok ? 'closing has no shell command' : `closing contains a shell command (${lead ? 'leading $' : m[0].trim()})`);
}

// lines: [{text?, speechS, sceneS}]
function checkVoiceFit(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const bad = list.map((l, i) => ({ i, r: l.sceneS > 0 ? l.speechS / l.sceneS : Infinity }))
    .filter((x) => x.r > VOICE_FIT_RATIO);
  return result('voiceFit', bad.length === 0,
    bad.length ? `line(s) need more than ${VOICE_FIT_RATIO}x scene time: ${bad.map((b) => `#${b.i + 1} (${b.r.toFixed(2)}x)`).join(', ')}`
      : `${list.length} line(s) fit within ${VOICE_FIT_RATIO}x`);
}

function checkSpeechCoverage(speechS, lengthS) {
  const total = Number(lengthS) || 0;
  const ratio = total > 0 ? (Number(speechS) || 0) / total : 0;
  return result('speechCoverage', ratio >= MIN_SPEECH_COVERAGE,
    `speech covers ${(ratio * 100).toFixed(0)}% of ${total}s (min ${MIN_SPEECH_COVERAGE * 100}%)`);
}

// frames: [{t, lumaStddev}]; frames after 0.5 s whose stddev < threshold are blank.
function checkBlankFrames(frames, threshold = DEFAULT_BLANK_STDDEV) {
  const list = Array.isArray(frames) ? frames : [];
  const bad = list.filter((f) => f.t > BLANK_AFTER_S && f.lumaStddev < threshold);
  return result('blankFrames', bad.length === 0,
    bad.length ? `blank frame(s) at ${bad.map((f) => `${f.t}s`).join(', ')}` : `${list.length} frame(s) non-blank`);
}

// Project Home's VideoPlayer draws the only control bar; a video that draws its own
// shows a second one under it. The injected player bridge script is not the video's.
const PLAYER_BRIDGE_BLOCK_RE = /<script\b[^>]*\bdata-sm-player-bridge\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const CONTROL_PATTERNS = [
  ['button', /<button\b/i],
  ['input', /<input\b/i],
  ['audio controls', /<audio\b[^>]*\scontrols\b/i],
  ['video controls', /<video\b[^>]*\scontrols\b/i],
];
function ownPlaybackControls(html) {
  const h = String(html || '').replace(PLAYER_BRIDGE_BLOCK_RE, '');
  return CONTROL_PATTERNS.filter(([, re]) => re.test(h)).map(([what]) => what);
}

function checkHtmlLimits({ html, bytes, lengthS } = {}) {
  const h = String(html || '');
  const size = Number.isFinite(bytes) ? bytes : Buffer.byteLength(h);
  const cap = Math.ceil((Number(lengthS) || 0) / 30) * HTML_MB_PER_30S;
  const problems = [];
  if (size > cap) problems.push(`${size} bytes exceeds cap ${cap}`);
  const dur = h.match(/<meta[^>]*name=["']sm-demo-duration["'][^>]*content=["']([^"']*)["']/i)
    || h.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']sm-demo-duration["']/i);
  if (!dur) problems.push('sm-demo-duration meta missing');
  else if (Number(dur[1]) !== Number(lengthS)) problems.push(`sm-demo-duration ${dur[1]} != ${lengthS}`);
  if (!/window\.smDemo\s*=/.test(h) || !/scenes\s*:/.test(h)) problems.push('window.smDemo with scenes missing');
  const controls = ownPlaybackControls(h);
  if (controls.length) problems.push(`own playback controls: ${controls.join(', ')}`);
  return result('htmlLimits', problems.length === 0, problems.length ? problems.join('; ') : `${size} bytes within cap ${cap}`);
}

// Share of the loudness envelope's modulation energy in the 2-8 Hz syllable band.
// Envelope = RMS over 20 ms windows (50 Hz), mean removed; energy by DFT over 0.5-25 Hz.
// Speech lands ~0.3+; a steady hum or drone lands well under 0.2.
function speechModulationShare(samples, sampleRate) {
  const sr = Number(sampleRate) || 0;
  const win = Math.max(1, Math.round(ENVELOPE_WINDOW_S * sr));
  const n = samples && samples.length ? Math.floor(samples.length / win) : 0;
  if (n < 4 || !sr) return 0;
  const env = new Float64Array(n);
  let mean = 0;
  for (let w = 0; w < n; w++) {
    let e = 0;
    for (let i = w * win; i < (w + 1) * win; i++) e += samples[i] * samples[i];
    env[w] = Math.sqrt(e / win);
    mean += env[w];
  }
  mean /= n;
  for (let w = 0; w < n; w++) env[w] -= mean;
  const envSr = sr / win;
  let band = 0;
  let total = 0;
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    const f = (k * envSr) / n;
    if (f < 0.5 || f > 25) continue;
    let re = 0;
    let im = 0;
    const step = (2 * Math.PI * k) / n;
    for (let w = 0; w < n; w++) { re += env[w] * Math.cos(step * w); im -= env[w] * Math.sin(step * w); }
    const p = re * re + im * im;
    total += p;
    if (f >= 2 && f <= 8) band += p;
  }
  return total > 0 ? band / total : 0;
}

function firstAudioDataUri(html) {
  const h = String(html || '');
  const m = /<audio\b[^>]*>/i.exec(h);
  if (!m) return null;
  const src = /\ssrc\s*=\s*["'](data:[^"']*)["']/i.exec(m[0]);
  if (src) return src[1];
  const rest = h.slice(m.index + m[0].length);
  const close = rest.search(/<\/audio>/i);
  const inner = close >= 0 ? rest.slice(0, close) : rest;
  const source = /<source\b[^>]*\ssrc\s*=\s*["'](data:[^"']*)["']/i.exec(inner);
  return source ? source[1] : null;
}

// Decodes the first <audio> data: URI through ffmpeg and fails when it has no speech-like modulation.
function checkAudioHasSpeech({ html } = {}) {
  const id = 'audio-speech';
  const uri = firstAudioDataUri(html);
  if (!uri) return result(id, false, 'no <audio> data: URI embedded in the HTML');
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(uri);
  if (!m) return result(id, false, 'embedded <audio> data: URI is malformed');
  const data = /;base64/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary');
  if (!data.length) return result(id, false, 'embedded <audio> data: URI is empty');
  const { runFfmpeg, decodeWavF32 } = require('./sound.cjs');
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvk-checks-'));
    const input = path.join(dir, 'audio.bin');
    const wav = path.join(dir, 'audio.f32.wav');
    fs.writeFileSync(input, data);
    runFfmpeg(['-hide_banner', '-nostats', '-y', '-i', input, '-vn', '-ac', '1', '-ar', String(DECODE_SR), '-c:a', 'pcm_f32le', wav]);
    const share = speechModulationShare(decodeWavF32(fs.readFileSync(wav)), DECODE_SR);
    return result(id, share >= MIN_SPEECH_MODULATION,
      `speech-band (2-8 Hz) modulation share ${share.toFixed(2)} (min ${MIN_SPEECH_MODULATION})`);
  } catch (e) {
    return result(id, false, `could not decode embedded audio with ffmpeg: ${String((e && e.message) || e).slice(0, 300)}`);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// input: {captions, narration (string|string[]), closing, lines, speechS, lengthS, frames, blankThreshold, html, bytes}
function runChecks(input = {}) {
  const out = [];
  if (input.captions) out.push(checkCaptions(input.captions));
  if (input.narration != null) out.push(lintLanguage(input.narration));
  if (input.closing != null) out.push(checkClosing(input.closing));
  if (input.lines) out.push(checkVoiceFit(input.lines));
  if (input.speechS != null) out.push(checkSpeechCoverage(input.speechS, input.lengthS));
  if (input.frames) out.push(checkBlankFrames(input.frames, input.blankThreshold));
  if (input.html != null) out.push(checkHtmlLimits({ html: input.html, bytes: input.bytes, lengthS: input.lengthS }));
  if (typeof input.html === 'string') out.push(checkAudioHasSpeech({ html: input.html }));
  return out;
}

module.exports = {
  BANNED_WORDS, countSyllables, checkCaptions, lintLanguage, checkClosing, checkVoiceFit,
  checkSpeechCoverage, checkBlankFrames, checkHtmlLimits, speechModulationShare, checkAudioHasSpeech, runChecks,
};

if (require.main === module) {
  try {
    const report = runChecks(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.some((c) => !c.ok) ? 1 : 0);
  } catch (e) {
    process.stderr.write(`checks: ${e.message}\n`);
    process.exit(2);
  }
}
