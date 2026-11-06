'use strict';
// Pure, dependency-free analyzers a demo-video builder must pass before saving.
// Node builtins only: this folder is copied to ~/.claude/session-manager/demo-video-kit/.
// Each check returns {id, ok, detail}. CLI: node checks.cjs <input.json> -> JSON, exit 1 on failure.

const fs = require('fs');

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
  return result('htmlLimits', problems.length === 0, problems.length ? problems.join('; ') : `${size} bytes within cap ${cap}`);
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
  return out;
}

module.exports = {
  BANNED_WORDS, countSyllables, checkCaptions, lintLanguage, checkClosing, checkVoiceFit,
  checkSpeechCoverage, checkBlankFrames, checkHtmlLimits, runChecks,
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
