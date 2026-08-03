/**
 * epicContextDigest.test.cjs — unit tests for buildContextDigest
 * (lib/epicContextDigest.cjs), which composes an Epic's goalText
 * (active-index.json, via epicMint.cjs) with its most-recent transcript
 * turns (promptSessionTranscript.cjs) into a bounded, real digest string.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/epicContextDigest.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildContextDigest } = require('../lib/epicContextDigest.cjs');
const { ensureEpic, MINT_AUTHORITY_NEW_EPIC_UI } = require('../lib/epicMint.cjs');
const { appendTurn } = require('../promptSessionTranscript.cjs');
const config = require('../config.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epiccontextdigest-cwd-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  return cwd;
}

test('normal digest: goalText followed by recent turns', async () => {
  const cwd = await mkCwd();
  const { epicId } = await ensureEpic(cwd, { goalText: 'Fix the flaky login test', status: 'proposed', mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI });
  await appendTurn(cwd, epicId, { role: 'user', text: 'Please investigate the flaky test.' });
  await appendTurn(cwd, epicId, { role: 'assistant', text: 'Found the race condition, fixing now.' });

  const digest = await buildContextDigest({ cwd, epicId });
  expect(digest).toContain('Fix the flaky login test');
  expect(digest).toContain('[user] Please investigate the flaky test.');
  expect(digest).toContain('[assistant] Found the race condition, fixing now.');
});

test('missing epicId returns empty string', async () => {
  const cwd = await mkCwd();
  expect(await buildContextDigest({ cwd, epicId: '' })).toBe('');
  expect(await buildContextDigest({ cwd })).toBe('');
});

test('epicId absent from active-index.json returns empty string', async () => {
  const cwd = await mkCwd();
  const digest = await buildContextDigest({ cwd, epicId: 'psess-does-not-exist' });
  expect(digest).toBe('');
});

test('empty transcript still returns goalText only, no throw', async () => {
  const cwd = await mkCwd();
  const { epicId } = await ensureEpic(cwd, { goalText: 'Empty transcript epic', status: 'proposed', mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI });

  const digest = await buildContextDigest({ cwd, epicId });
  expect(digest).toBe('Empty transcript epic');
});

test('maxChars truncation drops the oldest turns first, never a mid-turn slice', async () => {
  const cwd = await mkCwd();
  const { epicId } = await ensureEpic(cwd, { goalText: 'Truncation epic', status: 'proposed', mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI });
  await appendTurn(cwd, epicId, { role: 'user', text: 'oldest turn text goes here' });
  await appendTurn(cwd, epicId, { role: 'assistant', text: 'middle turn text goes here' });
  await appendTurn(cwd, epicId, { role: 'user', text: 'newest turn text goes here' });

  // Small enough that only the newest turn (plus goalText) can fit.
  const digest = await buildContextDigest({ cwd, epicId, maxChars: 80 });

  expect(digest.length).toBeLessThanOrEqual(80);
  expect(digest).toContain('newest turn text goes here');
  expect(digest).not.toContain('oldest turn text goes here');
  expect(digest).not.toContain('middle turn text goes here');
  // No turn line appears partially — every included "[role] " line is whole.
  for (const line of digest.split('\n')) {
    if (line.startsWith('[')) {
      expect(line).toMatch(/^\[(user|assistant)\] .+$/);
    }
  }
});

test('maxChars smaller than goalText alone clamps the header itself, never exceeding the bound', async () => {
  const cwd = await mkCwd();
  const longGoal = 'This is a deliberately long goalText that on its own already exceeds the small maxChars bound used below';
  const { epicId } = await ensureEpic(cwd, { goalText: longGoal, status: 'proposed', mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI });
  await appendTurn(cwd, epicId, { role: 'user', text: 'a turn that cannot possibly fit either' });

  const digest = await buildContextDigest({ cwd, epicId, maxChars: 20 });

  expect(digest.length).toBe(20);
  expect(digest).toBe(longGoal.slice(0, 20));
});
