/**
 * videoPressLines.test.cjs — a scripted Demo Video press validates its choices and
 * builds exactly the prompt lines the Project Home composer (renderer
 * composerTemplates.ts videoPromptLines) sends for the same choices.
 *
 * Run: timeout 300 npx vitest run src/main/lib/project-pages/__tests__/videoPressLines.test.cjs
 */
'use strict';

import { test, expect, beforeAll } from 'vitest';
const { parseScriptPress, pressLines } = require('../videoPressLines.cjs');

let renderer;
beforeAll(async () => {
  renderer = await import('../../../../renderer/components/tabs/projecthome/projectpages/composerTemplates.ts');
});

function ok(body) {
  const r = parseScriptPress(body);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.cfg;
}

function refused(body) {
  const r = parseScriptPress(body);
  expect(r.ok).toBe(false);
  expect(typeof r.error).toBe('string');
  expect(r.error.length).toBeGreaterThan(0);
  expect(r.error).not.toMatch(/\n/);
  return r.error;
}

const BODIES = [
  { kind: 'Project demo' },
  { kind: 'project-demo', target: 'ignored for a demo', length: 60, style: 'Professional', focus: 'Lead with the CLI' },
  { kind: 'Blog post', target: 'posts/2026-11-hello.md', voiceId: 'narrator-1', reviewFirst: true },
  { kind: 'blog-post', target: '  Release 1.2 notes  ', style: 'Kinetic typography', character: false, focus: '  Keep it short.\nEnd on the install line  ' },
  { kind: 'Feature', target: 'Voice library', length: 60, style: 'Animated whiteboard', voiceId: 'amy_2', character: false },
  { kind: 'feature', target: 'Scheduler', style: 'Fun' },
  { kind: 'TikTok', length: 15, style: 'Fun', voiceId: 'v1' },
  { kind: 'tiktok', target: 'The one-key launch', length: 60, character: false, focus: 'Hook in 2 seconds' },
  { kind: 'Marketing' },
  { kind: 'marketing', target: 'Spring launch', voiceId: 'brand-voice', focus: 'Name the price: free', character: false },
];

test('pressLines equals renderer videoPromptLines for every kind and option mix', () => {
  const kinds = new Set();
  for (const body of BODIES) {
    const cfg = ok(body);
    kinds.add(cfg.kind);
    expect(pressLines(cfg)).toEqual(renderer.videoPromptLines(cfg));
  }
  expect([...kinds].sort()).toEqual([...renderer.VIDEO_KINDS].sort());
});

test('defaults: length 30, style Auto, Character on, review off, no voice/focus lines', () => {
  const cfg = ok({ kind: 'Marketing' });
  expect(cfg).toMatchObject({ kind: 'Marketing', target: '', style: 'Auto', length: 30, mascot: true, review: false, focus: '' });
  expect(pressLines(cfg)).toEqual(['Video kind: Marketing', 'Video style: Auto', 'Video length: 30', 'Character: on']);
});

test('slugs map to display kinds; reviewFirst and voiceId land on the cfg', () => {
  const cfg = ok({ kind: 'blog-post', target: 'x', reviewFirst: true, voiceId: 'narrator-1' });
  expect(cfg.kind).toBe('Blog post');
  expect(cfg.review).toBe(true);
  expect(cfg.voice).toBe('narrator-1');
  expect(pressLines(cfg)).not.toContain('Review: on');
  expect(pressLines(cfg).some((l) => /^Review:/.test(l))).toBe(false);
});

test('a demo press names no target line even when one is sent', () => {
  const lines = pressLines(ok({ kind: 'Project demo', target: 'something' }));
  expect(lines.some((l) => l.startsWith('Video target:'))).toBe(false);
});

test('refuses a non-object body', () => {
  refused(null);
  refused('Project demo');
  refused([]);
});

test('refuses a missing or unknown kind', () => {
  refused({});
  refused({ kind: 'Trailer' });
  refused({ kind: 'project demo' });
  refused({ kind: 7 });
});

test('refuses a bad length; 15 only for TikTok', () => {
  refused({ kind: 'Marketing', length: 45 });
  refused({ kind: 'Marketing', length: '30' });
  refused({ kind: 'Marketing', length: 15 });
  refused({ kind: 'Feature', target: 'x', length: 15 });
  expect(ok({ kind: 'TikTok', length: 15 }).length).toBe(15);
  expect(ok({ kind: 'Feature', target: 'x', length: 60 }).length).toBe(60);
});

test('refuses an unknown style', () => {
  refused({ kind: 'Marketing', style: 'Noir' });
  refused({ kind: 'Marketing', style: 'auto' });
  refused({ kind: 'Marketing', style: 3 });
});

test('refuses non-boolean character and reviewFirst', () => {
  refused({ kind: 'Marketing', character: 'off' });
  refused({ kind: 'Marketing', character: 0 });
  refused({ kind: 'Marketing', reviewFirst: 'yes' });
  refused({ kind: 'Marketing', reviewFirst: 1 });
});

test('refuses a voiceId that does not match VOICE_ID_RE', () => {
  refused({ kind: 'Marketing', voiceId: 'Bad Voice' });
  refused({ kind: 'Marketing', voiceId: '-lead' });
  refused({ kind: 'Marketing', voiceId: 'a'.repeat(65) });
  refused({ kind: 'Marketing', voiceId: '' });
  refused({ kind: 'Marketing', voiceId: 5 });
  expect(ok({ kind: 'Marketing', voiceId: 'a'.repeat(64) }).voice).toBe('a'.repeat(64));
});

test('target is required for Blog post and Feature', () => {
  refused({ kind: 'Blog post' });
  refused({ kind: 'blog-post', target: '   ' });
  refused({ kind: 'Feature' });
  refused({ kind: 'feature', target: '' });
  ok({ kind: 'TikTok' });
  ok({ kind: 'Marketing' });
  ok({ kind: 'Project demo' });
});

test('target: one line, <= 500 chars, no control characters, a string', () => {
  refused({ kind: 'Feature', target: 'line one\nline two' });
  refused({ kind: 'Feature', target: 'line one\rline two' });
  refused({ kind: 'Feature', target: 'tab\there' });
  refused({ kind: 'Feature', target: 'nul\u0000here' });
  refused({ kind: 'Feature', target: 'del\u007fhere' });
  refused({ kind: 'Feature', target: 'x'.repeat(501) });
  refused({ kind: 'Feature', target: 42 });
  expect(ok({ kind: 'Feature', target: 'x'.repeat(500) }).target).toBe('x'.repeat(500));
});

test('focus: <= 2000 chars and a string', () => {
  refused({ kind: 'Marketing', focus: 'x'.repeat(2001) });
  refused({ kind: 'Marketing', focus: ['a'] });
  ok({ kind: 'Marketing', focus: 'x'.repeat(2000) });
});

test("refuses any 'Review:' or 'Replace entry:' line in target or focus", () => {
  refused({ kind: 'Feature', target: 'Review: on' });
  refused({ kind: 'Feature', target: '  review: off' });
  refused({ kind: 'Feature', target: 'Replace entry: vid-abc' });
  refused({ kind: 'Marketing', target: 'Replace entry:vid-abc' });
  refused({ kind: 'Marketing', focus: 'Keep it short\nReview: on' });
  refused({ kind: 'Marketing', focus: 'Keep it short\r\n  Replace entry: vid-abc\nmore' });
  refused({ kind: 'Marketing', focus: 'REVIEW: on' });
  // Mid-line mentions are not a line of their own.
  ok({ kind: 'Marketing', focus: 'Mention the Review: step mid-sentence' });
});
