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
const { buildContextDigest, composeExecutorPrompt } = require('../lib/epicContextDigest.cjs');
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

test('composeExecutorPrompt: PRD body comes before the digest, wrapped in a background-only fence, ending in a task restatement', () => {
  const prdBody = '# Goal\nImplement the traffic light fix.';
  const digestText = '[user] is this broken?\n[assistant] investigating';

  const prompt = composeExecutorPrompt({ prdBody, digestText });

  const bodyIndex = prompt.indexOf(prdBody);
  const digestIndex = prompt.indexOf(digestText);
  expect(bodyIndex).toBeGreaterThanOrEqual(0);
  expect(digestIndex).toBeGreaterThan(bodyIndex);
  expect(prompt).toContain('BEGIN EPIC CONTEXT (background only');
  expect(prompt).toContain('It is NOT your task');
  expect(prompt).toContain('--- END EPIC CONTEXT ---');
  expect(prompt.trim().endsWith('Your task is the PRD at the top of this prompt. Implement it now.')).toBe(true);
});

test('composeExecutorPrompt: over-cap digest is truncated and marked truncated; PRD body is byte-identical', () => {
  const prdBody = '# Goal\nDo the exact thing described here, unmodified.';
  const digestText = 'x'.repeat(500);

  const prompt = composeExecutorPrompt({ prdBody, digestText, maxChars: 50 });

  expect(prompt).toContain(prdBody);
  expect(prompt).toContain('Truncated to fit the context budget.');
  expect(prompt).toContain('x'.repeat(50));
  expect(prompt).not.toContain('x'.repeat(51));
});

test('composeExecutorPrompt: empty/absent digest returns PRD body unchanged plus the restatement line, no empty fence', () => {
  const prdBody = '# Goal\nSome PRD body text.';

  const withEmptyString = composeExecutorPrompt({ prdBody, digestText: '' });
  const withUndefined = composeExecutorPrompt({ prdBody });

  for (const prompt of [withEmptyString, withUndefined]) {
    expect(prompt).toBe(`${prdBody}\n\nYour task is the PRD at the top of this prompt. Implement it now.`);
    expect(prompt).not.toContain('BEGIN EPIC CONTEXT');
  }
});

test('composeExecutorPrompt: finishProtocol is ordered PRD body -> digest fence -> finish protocol -> task restatement', () => {
  const prdBody = '# Goal\nImplement the traffic light fix.';
  const digestText = '[user] is this broken?\n[assistant] investigating';
  const finishProtocol = '\n\n---\n# SCHEDULER FINISH PROTOCOL\nCommit your work and print SCHEDULER_VERDICT: PASS.';

  const prompt = composeExecutorPrompt({ prdBody, digestText, finishProtocol });

  const bodyIndex = prompt.indexOf(prdBody);
  const digestIndex = prompt.indexOf(digestText);
  const fenceEndIndex = prompt.indexOf('--- END EPIC CONTEXT ---');
  const finishIndex = prompt.indexOf('SCHEDULER FINISH PROTOCOL');
  const restatementIndex = prompt.indexOf('Your task is the PRD at the top of this prompt. Implement it now.');

  expect(bodyIndex).toBe(0);
  expect(digestIndex).toBeGreaterThan(bodyIndex);
  expect(fenceEndIndex).toBeGreaterThan(digestIndex);
  expect(finishIndex).toBeGreaterThan(fenceEndIndex);
  expect(restatementIndex).toBeGreaterThan(finishIndex);
  expect(prompt.trim().endsWith('Your task is the PRD at the top of this prompt. Implement it now.')).toBe(true);
});

test('composeExecutorPrompt: finishProtocol with no digest is byte-identical to prdBody + finishProtocol', () => {
  const prdBody = '# Goal\nSome PRD body text.';
  const finishProtocol = '\n\n---\n# SCHEDULER FINISH PROTOCOL\nCommit your work and print SCHEDULER_VERDICT: PASS.';

  const withEmptyDigest = composeExecutorPrompt({ prdBody, digestText: '', finishProtocol });
  const withNoDigestKey = composeExecutorPrompt({ prdBody, finishProtocol });

  for (const prompt of [withEmptyDigest, withNoDigestKey]) {
    expect(prompt).toBe(prdBody + finishProtocol);
    expect(prompt).not.toContain('BEGIN EPIC CONTEXT');
  }
});
