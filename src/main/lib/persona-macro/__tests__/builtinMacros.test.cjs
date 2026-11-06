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

test('builtin demo-video macro is v5 with the character + styles + length prompt', () => {
  const macro = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  expect(macro.builtinVersion).toBe(5);
  expect(macro.priorPrompts).toHaveLength(4);
  expect(macro.prompt).toContain('Video length: 60');
  expect(macro.prompt).not.toContain('30-second');
  expect(macro.prompt).toContain('Generate a character and cute animated JavaScript video');
  for (const style of ['Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography']) {
    expect(macro.prompt).toContain(style);
  }
  expect(macro.prompt).toContain('Video style: <name>');
  expect(macro.prompt).toContain('project_demo_video_write');
  expect(macro.prompt).toContain('htmlPath');
  expect(macro.prompt).toContain('Kokoro');
});

test('demo-video-builder persona is opus / max / seedVersion 5', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  const fm = frontmatter(raw);
  expect(fm.model).toBe('opus');
  expect(fm.effort).toBe('max');
  expect(fm.seedVersion).toBe('6');
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
  expect(head).toContain('</call_to_action>');
  expect(head).toContain('truncation notice');
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
    artifactPaths: ['session-manager-operations/project-pages/demo-video/index.html'],
  });
  expect(home.job).toEqual({
    estimateMinutes: 20,
    artifactPaths: ['session-manager-operations/project-pages/home.html'],
  });
  for (const m of [demo, home]) {
    expect(Object.isFrozen(m.job)).toBe(true);
    expect(Object.isFrozen(m.job.artifactPaths)).toBe(true);
  }
  expect(home.builtinVersion).toBe(1);
  expect(demo.builtinVersion).toBe(5);
  expect(demo.priorPrompts).toHaveLength(4);
});
