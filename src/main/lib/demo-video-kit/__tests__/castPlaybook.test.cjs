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

test('cast.md states the sfx and project sounds rules', () => {
  const md = fs.readFileSync(CAST_MD, 'utf8');
  for (const s of ['`sfx`', '`sounds`', '`beds`', 'Never swap in another sound']) {
    expect(md).toContain(s);
  }
});

test('cast.md is project-neutral and at most 3,000 bytes', () => {
  const md = fs.readFileSync(CAST_MD, 'utf8');
  expect(md).not.toMatch(/burrow|bilko|zora|pesho|veggie|garden/i);
  expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(3000);
});

// project-home-html.md — the rules the Project Home HTML personas (demo-video-builder, project-home-builder) share.
const os = require('node:os');
const { seedDemoVideoKit } = require('../seedKit.cjs');
const PH_MD = path.join(__dirname, '..', 'project-home-html.md');

test('project-home-html.md is seeded with the kit', () => {
  expect(kitFiles()).toContain('project-home-html.md');
});

test('seedDemoVideoKit copies project-home-html.md into destDir', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-html-kit-'));
  try {
    const r = await seedDemoVideoKit({ destDir, logger: {} });
    expect(r.seeded).toBe(true);
    const copied = path.join(destDir, 'project-home-html.md');
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, 'utf8')).toBe(fs.readFileSync(PH_MD, 'utf8'));
  } finally {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('project-home-html.md states the Epic, sandboxed-frame and one-document rules', () => {
  const md = fs.readFileSync(PH_MD, 'utf8');
  for (const s of ['Session Manager Epic', 'sandboxed frame', 'Project Home', 'exactly one complete HTML document', '<style>', '@import', 'url(http', 'external fonts']) {
    expect(md).toContain(s);
  }
  expect(md).not.toMatch(/burrow|bilko|zora|pesho|veggie|garden/i);
});
