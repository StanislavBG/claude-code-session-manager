/**
 * kindPlaybooks.test.cjs — the per-kind playbooks ship in the seeded kit and stay project-neutral.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/kindPlaybooks.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { kitFiles } = require('../seedKit.cjs');

const KIT_DIR = path.join(__dirname, '..');
const TIKTOK_MD = path.join(KIT_DIR, 'kind-tiktok.md');
const readTiktok = () => fs.readFileSync(TIKTOK_MD, 'utf8');

test('kind-tiktok.md is seeded and states the TikTok format, contract and rules', () => {
  expect(kitFiles()).toContain('kind-tiktok.md');
  const md = readTiktok();
  for (const s of ['1080x1920', 'sm-demo-aspect', 'Season complete', 'smDemo.beats', '150 characters']) {
    expect(md).toContain(s);
  }
});

test('kind-tiktok.md series rule saves a season-complete outcome', () => {
  const md = readTiktok();
  expect(md).toContain('project_video_outcome_write');
  expect(md).toContain('Season complete');
  expect(md).toMatch(/outcome:\s*'season-complete'/);
  expect(md).toMatch(/review stage or the final stage/);
  expect(md).toContain('end PASS');
});

test('kind-tiktok.md holds no other project\'s own content', () => {
  expect(readTiktok()).not.toMatch(/burrow|bilko|veggie|garden/i);
});

const MARKETING_MD = path.join(KIT_DIR, 'kind-marketing.md');
const readMarketing = () => fs.readFileSync(MARKETING_MD, 'utf8');

test('kind-marketing.md is seeded and states the Marketing format, grounding and kit rules', () => {
  expect(kitFiles()).toContain('kind-marketing.md');
  const md = readMarketing();
  for (const s of ['16:9', 'verbatim', 'capture.cjs', 'call to action', '-14 LUFS']) {
    expect(md).toContain(s);
  }
});

test('kind-marketing.md says how to request, embed and seek real product clips', () => {
  const md = readMarketing();
  expect(md).toContain("kind: 'clip'");
  expect(md).toContain('currentTime');
  expect(md).toMatch(/durationS[^\n]*2 to 6/);
  expect(md).toContain('<video muted playsinline preload="auto" src="data:video/mp4;base64,..."></video>');
  expect(md).toContain('t - clipStart');
  expect(md).toMatch(/No `controls`, no `autoplay`/);
  expect(md).toContain('dropped');
  expect(md).toMatch(/Clips count toward the document size cap/);
});

test('kind-marketing.md holds no other project\'s own content', () => {
  expect(readMarketing()).not.toMatch(/burrow|bilko|veggie|garden/i);
});
