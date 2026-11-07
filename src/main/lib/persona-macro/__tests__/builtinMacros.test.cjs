/**
 * builtinMacros.test.cjs — the seeded Demo Video macro and its bundled persona.
 *
 * Run: timeout 300 npx vitest run src/main/lib/persona-macro/__tests__/builtinMacros.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { BUILTIN_MACROS } = require('../builtinMacros.cjs');

const personaPath = path.join(__dirname, '..', '..', '..', '..', 'seed', 'agents', 'demo-video-builder.md');

function frontmatter(doc) {
  const m = doc.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  for (const line of (m ? m[1] : '').split('\n')) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

test('builtin demo-video macro is v6 with the character + styles + length prompt', () => {
  const macro = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  expect(macro.builtinVersion).toBe(6);
  expect(macro.priorPrompts).toHaveLength(5);
  expect(macro.builtinVersion).toBe(macro.priorPrompts.length + 1);
  for (const t of ['project_video_write', 'Video kind:', 'Video target:', 'Entry id']) expect(macro.prompt).toContain(t);
  expect(macro.prompt).toContain('Video length: 60');
  expect(macro.prompt).not.toContain('30-second');
  expect(macro.prompt).toContain('Generate a character and cute animated JavaScript video');
  for (const style of ['Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography']) {
    expect(macro.prompt).toContain(style);
  }
  expect(macro.prompt).toContain('Video style: <name>');
    expect(macro.prompt).toContain('htmlPath');
  expect(macro.prompt).toContain('Kokoro');
});

test('demo-video-builder persona is opus / max / seedVersion 9 or later', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  const fm = frontmatter(raw);
  expect(fm.model).toBe('opus');
  expect(fm.effort).toBe('max');
  expect(Number.isInteger(Number(fm.seedVersion))).toBe(true);
  expect(Number(fm.seedVersion) >= 9).toBe(true);
});

function personaBody() {
  return fs.readFileSync(personaPath, 'utf8').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

test('demo-video-builder persona sections are balanced and never nested', () => {
  const body = personaBody();
  let open = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^<(\/?)([a-z_]+)>$/);
    if (!m) continue;
    if (m[1] === '') {
      expect(open).toBeNull();
      open = m[2];
    } else {
      expect(open).toBe(m[2]);
      open = null;
    }
  }
  expect(open).toBeNull();
  expect(body).not.toMatch(/`<[a-z_]+>$/m);
});

test('demo-video-builder persona keeps its output contract rules', () => {
  const body = personaBody();
  for (const needle of ['XMLHttpRequest', 'system font stack', 'prefers-reduced-motion', 'Under 2 MB total', 'Never retype the base64 audio']) {
    expect(body).toContain(needle);
  }
});

test('plain language and close rules sit above the intake cut', () => {
  const { AGENT_BODY_CHAR_CAP } = require('../../claude/agentModelResolve.cjs');
  const head = personaBody().slice(0, AGENT_BODY_CHAR_CAP);
  expect(head).toContain('</audience_and_language>');
  expect(head).toContain('</length_and_pacing>');
  expect(head).toContain('</call_to_action>');
  expect(head).toContain('truncation notice');
});

test('persona is length-aware, slower, and has the whiteboard palette', () => {
  const body = personaBody();
  for (const needle of ['Video length: 60', 'content="D"', 'duration: D', 'np.zeros(D * sr', 'at least 5 s', 'at least 1.0 s', 'at least 6 marker-drawn elements', '#D62828', '#E4471C', '#F77F00']) {
    expect(body).toContain(needle);
  }
  for (const gone of ['content="30"', 'duration: 30', 'np.zeros(30 * sr', 'a 30-second animated demo']) {
    expect(body).not.toContain(gone);
  }
});

test('persona absorbs the marketing-video rules and saves with project_video_write', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  const body = personaBody();
  expect(raw).toContain('mcp__session-manager-scheduler__project_video_write');
  expect(raw).toContain('mcp__session-manager-scheduler__project_character_write');
  for (const needle of ['project_video_write', 'demo-video-kit', 'Video kind', 'Entry id', '-14 LUFS', '1.2x', '_character']) {
    expect(body).toContain(needle);
  }
});

test('script_first no longer closes on a command', () => {
  const body = personaBody();
  const section = body.slice(body.indexOf('<script_first>'), body.indexOf('</script_first>'));
  expect(section).not.toContain('get-started');
  expect(body).not.toContain('instead of paraphrasing');
});

test('narration recipe normalizes loudness', () => {
  const body = personaBody();
  expect(body).toContain('loudnorm=I=-14');
  expect(body).toContain("'-af', LOUDNESS");
});

test('built-in macros declare a frozen background job', () => {
  const demo = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  const home = BUILTIN_MACROS.find((m) => m.id === 'builtin-project-home');
  expect(demo.job).toEqual({
    estimateMinutes: 60,
    entryKind: 'video',
    artifactPaths: ['session-manager-operations/project-pages/videos/{id}/index.html'],
  });
  expect(home.job).toEqual({
    estimateMinutes: 20,
    entryKind: 'knowledge',
    artifactPaths: ['session-manager-operations/project-pages/knowledge/{id}/index.html'],
  });
  for (const m of [demo, home]) {
    expect(Object.isFrozen(m.job)).toBe(true);
    expect(Object.isFrozen(m.job.artifactPaths)).toBe(true);
  }
  expect(home.builtinVersion).toBe(2);
  expect(home.priorPrompts).toHaveLength(1);
  for (const m of [demo, home]) expect(m.builtinVersion).toBe(m.priorPrompts.length + 1);
  expect(home.prompt).toContain('project_page_write');
  expect(home.prompt).toContain("'Page:");
  expect(home.prompt).toContain("'Entry id'");
  expect(demo.builtinVersion).toBe(6);
  expect(demo.priorPrompts).toHaveLength(5);
});

test('builtin-review-md-network is a job-less project-home macro with scope + mode inputs', () => {
  const crypto = require('node:crypto');
  const { MacroSchema, renderMacroPrompt, defaultMacroValues, ensureBuiltins } = require('../macroLibrary.cjs');
  const sha = (id) => crypto.createHash('sha256').update(JSON.stringify(BUILTIN_MACROS.find((m) => m.id === id))).digest('hex');
  expect(sha('builtin-project-home')).toBe('a6862158c0eabe4381f5a121193109ddb45f8e24a945435a617ad83ea57d956b');
  expect(sha('builtin-demo-video')).toBe('e74120a2cd3621b4e4828a99d1f03e0c1da92ab82d52734e7a390e5dfe537e10');

  const b = BUILTIN_MACROS.find((m) => m.id === 'builtin-review-md-network');
  expect(b).toBeTruthy();
  expect(Object.isFrozen(b)).toBe(true);
  expect(b.label).toBe('Review MD network');
  expect(b.agentName).toBe('architect');
  expect(b.tag).toBe('discussion');
  expect(b.surface).toBe('project-home');
  expect(b.projects).toEqual(['*']);
  expect(b.builtinVersion).toBe(1);
  expect(b.priorPrompts).toEqual([]);
  expect(b.supersedes).toEqual(['review-md-network-d38ffd']);
  expect('job' in b).toBe(false);
  expect(b.inputs).toEqual([
    { name: 'scope', label: 'Scope', default: 'the whole project', required: true },
    { name: 'mode', label: 'Mode', options: ['Full review', 'Drift check'], default: 'Full review', required: true },
  ]);
  expect(b.prompt).toBe(
    "Use the session-manager-dev:maintaining-md-network skill to review this project's markdown network. Scope: {{scope}}. Mode: {{mode}}.",
  );

  const stamp = '2026-01-01T00:00:00.000Z';
  const parsed = MacroSchema.safeParse({ ...b, builtin: true, createdAt: stamp, updatedAt: stamp });
  expect(parsed.success).toBe(true);

  const r = renderMacroPrompt(b.prompt, b.inputs, defaultMacroValues(b.inputs));
  expect(r.ok).toBe(true);
  expect(r.prompt).toContain('Scope: the whole project.');
  expect(r.prompt).toContain('Mode: Full review.');

  const custom = {
    id: 'review-md-network-d38ffd', label: 'Review MD network', agentName: 'architect', tag: 'discussion',
    prompt: 'x', projects: ['*'], surface: 'project-home', createdAt: stamp, updatedAt: stamp,
  };
  const out = ensureBuiltins([custom], [b]);
  expect(out.retired).toEqual(['review-md-network-d38ffd']);
  const seeded = out.macros.find((m) => m.id === 'builtin-review-md-network');
  expect(seeded.inputs).toEqual(b.inputs);
  expect(out.macros.find((m) => m.id === 'review-md-network-d38ffd')).toBeUndefined();
});
