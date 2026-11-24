/**
 * castPlaybook.test.cjs — the cast playbook ships in the seeded kit, states the cast rules and stays project-neutral.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/castPlaybook.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { kitFiles } = require('../seedKit.cjs');

const CAST_MD = path.join(__dirname, '..', 'cast.md');

test('cast.md is seeded with the kit', () => {
  expect(kitFiles()).toContain('cast.md');
});

test('cast.md states the speaker, voice, voiceless, look and Character: off rules', () => {
  const md = fs.readFileSync(CAST_MD, 'utf8');
  for (const s of ['speaker', 'character.cjs speak', 'never speaks', 'sound.cjs', 'character.js', 'Character: off', 'no fallback']) {
    expect(md).toContain(s);
  }
});

test('cast.md is project-neutral and at most 3,000 bytes', () => {
  const md = fs.readFileSync(CAST_MD, 'utf8');
  expect(md).not.toMatch(/burrow|bilko|zora|pesho/i);
  expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(3000);
});
