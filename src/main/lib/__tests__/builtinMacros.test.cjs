/**
 * builtinMacros.test.cjs — the seeded Demo Video macro and its bundled persona.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/builtinMacros.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { BUILTIN_MACROS } = require('../builtinMacros.cjs');

const personaPath = path.join(__dirname, '..', '..', '..', 'seed', 'agents', 'demo-video-builder.md');

function frontmatter(doc) {
  const m = doc.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  for (const line of (m ? m[1] : '').split('\n')) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

test('builtin demo-video macro is v4 with the character + styles prompt', () => {
  const macro = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');
  expect(macro.builtinVersion).toBe(4);
  expect(macro.prompt).toContain('Generate a character and cute animated JavaScript video');
  for (const style of ['Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography']) {
    expect(macro.prompt).toContain(style);
  }
  expect(macro.prompt).toContain('Video style: <name>');
  expect(macro.prompt).toContain('project_demo_video_write');
  expect(macro.prompt).toContain('htmlPath');
  expect(macro.prompt).toContain('Kokoro');
});

test('demo-video-builder persona is opus / max / seedVersion 4', () => {
  const raw = fs.readFileSync(personaPath, 'utf8');
  const fm = frontmatter(raw);
  expect(fm.model).toBe('opus');
  expect(fm.effort).toBe('max');
  expect(fm.seedVersion).toBe('4');
});
