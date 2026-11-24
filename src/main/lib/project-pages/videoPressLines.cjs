'use strict';

/**
 * videoPressLines.cjs — a scripted Demo Video press: validate its choices and
 * build exactly the prompt lines the Project Home composer sends for the same
 * choices, so a scripted press runs the same job as a human press.
 *
 * Pure: no fs, no IPC. Mirrors renderer composerTemplates.ts (VIDEO_KINDS,
 * videoLengthsFor, voiceLine, videoPromptLines); main may not import renderer
 * code, so __tests__/videoPressLines.test.cjs asserts the two stay identical.
 * Whether a voice exists in the project's library is the route's check, not this one.
 *
 *   parseScriptPress(body) -> { ok: true, cfg } | { ok: false, error }  (error: one line)
 *     body: { kind, target?, length?, style?, character?, voiceId?, focus?, reviewFirst? }
 *     cfg (renderer VideoCfg shape): { kind, target, style, length, mascot, review, focus, voice? }
 *   pressLines(cfg) -> string[]
 *
 * Review first travels only as cfg.review (the press's reviewStage), never as a
 * line; a 'Review:' or 'Replace entry:' line in target or focus is refused so a
 * script cannot forge an owner approval or overwrite an entry.
 */

const { VOICE_ID_RE } = require('../demo-video-kit/voiceLibrary.cjs');

const VIDEO_KINDS = Object.freeze(['Project demo', 'Blog post', 'Feature', 'TikTok', 'Marketing']);
const KIND_SLUGS = Object.freeze({
  'project-demo': 'Project demo',
  'blog-post': 'Blog post',
  feature: 'Feature',
  tiktok: 'TikTok',
  marketing: 'Marketing',
});
const VIDEO_STYLES = Object.freeze(['Auto', 'Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography']);
const TARGET_REQUIRED_KINDS = Object.freeze(['Blog post', 'Feature']);
const MAX_TARGET = 500;
const MAX_FOCUS = 2000;
const RESERVED_LINE_RE = /^\s*(review|replace entry)\s*:/im;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const FOCUS_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** The length chips a kind offers: 15 s only for TikTok (renderer videoLengthsFor). */
function videoLengthsFor(kind) {
  return kind === 'TikTok' ? [15, 30, 60] : [30, 60];
}

function fail(error) {
  return { ok: false, error };
}

function parseScriptPress(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('press body must be an object');

  const rawKind = body.kind;
  if (typeof rawKind !== 'string') return fail(`kind is required: one of ${VIDEO_KINDS.join(', ')}`);
  const kind = VIDEO_KINDS.includes(rawKind) ? rawKind : Object.prototype.hasOwnProperty.call(KIND_SLUGS, rawKind) ? KIND_SLUGS[rawKind] : null;
  if (!kind) return fail(`unknown kind '${oneLine(rawKind)}': one of ${VIDEO_KINDS.join(', ')} (or its slug)`);

  let length = 30;
  if (body.length !== undefined) {
    const allowed = videoLengthsFor(kind);
    if (typeof body.length !== 'number' || !allowed.includes(body.length)) {
      return fail(`length for ${kind} must be one of ${allowed.join(', ')}`);
    }
    length = body.length;
  }

  let style = 'Auto';
  if (body.style !== undefined) {
    if (typeof body.style !== 'string' || !VIDEO_STYLES.includes(body.style)) {
      return fail(`style must be one of ${VIDEO_STYLES.join(', ')}`);
    }
    style = body.style;
  }

  let mascot = true;
  if (body.character !== undefined) {
    if (typeof body.character !== 'boolean') return fail('character must be true or false');
    mascot = body.character;
  }

  let review = false;
  if (body.reviewFirst !== undefined) {
    if (typeof body.reviewFirst !== 'boolean') return fail('reviewFirst must be true or false');
    review = body.reviewFirst;
  }

  let voice;
  if (body.voiceId !== undefined) {
    if (typeof body.voiceId !== 'string' || !VOICE_ID_RE.test(body.voiceId)) {
      return fail(`voiceId must match ${VOICE_ID_RE}`);
    }
    voice = body.voiceId;
  }

  let target = '';
  if (body.target !== undefined) {
    if (typeof body.target !== 'string') return fail('target must be a string');
    if (CONTROL_RE.test(body.target)) return fail('target must be one line with no control characters');
    target = body.target.trim();
    if (target.length > MAX_TARGET) return fail(`target must be at most ${MAX_TARGET} characters`);
    if (RESERVED_LINE_RE.test(target)) return fail("target may not carry a 'Review:' or 'Replace entry:' line");
  }
  if (TARGET_REQUIRED_KINDS.includes(kind) && !target) return fail(`target is required for a ${kind} video`);

  let focus = '';
  if (body.focus !== undefined) {
    if (typeof body.focus !== 'string') return fail('focus must be a string');
    if (FOCUS_CONTROL_RE.test(body.focus)) return fail('focus may not contain control characters');
    focus = body.focus.trim();
    if (focus.length > MAX_FOCUS) return fail(`focus must be at most ${MAX_FOCUS} characters`);
    if (RESERVED_LINE_RE.test(focus)) return fail("focus may not carry a 'Review:' or 'Replace entry:' line");
  }

  const cfg = { kind, target, style, length, mascot, review, focus };
  if (voice) cfg.voice = voice;
  return { ok: true, cfg };
}

/** Same lines as renderer videoPromptLines(cfg); a target is named only for a non-demo kind. */
function pressLines(cfg) {
  const lines = [`Video kind: ${cfg.kind}`];
  const target = (cfg.target || '').trim();
  if (cfg.kind !== 'Project demo' && target) lines.push(`Video target: ${target}`);
  lines.push(`Video style: ${cfg.style}`);
  const voice = typeof cfg.voice === 'string' ? cfg.voice.trim() : '';
  if (voice) lines.push(`Voice: ${voice}`);
  lines.push(`Video length: ${cfg.length}`, `Character: ${cfg.mascot ? 'on' : 'off'}`);
  const focus = (cfg.focus || '').trim();
  if (focus) lines.push(focus);
  return lines;
}

function oneLine(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 80);
}

module.exports = {
  parseScriptPress,
  pressLines,
  VIDEO_KINDS,
  VIDEO_STYLES,
  KIND_SLUGS,
  MAX_TARGET,
  MAX_FOCUS,
};
