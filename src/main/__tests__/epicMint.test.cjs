/**
 * epicMint.test.cjs — unit tests for ensureEpic's sourcePromptId join
 * semantics (see PRD authoring notes: sourcePromptId must be an existing
 * Epic's promptSessionId, i.e. its active-index.json sessions key — NOT a
 * PromptTicket.id).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epicMint.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureEpic, removeEpic, readActiveIndex, findJoinableEpic } = require('../lib/epicMint.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicmint-cwd-'));
  tmpDirs.push(cwd);
  return cwd;
}

test('ensureEpic mints a new Epic when explicit epicId matches no existing Epic (documents current behavior for a stray PromptTicket.id)', async () => {
  const cwd = await mkCwd();
  const notAPromptSessionId = 'ticket-abc123';

  const result = await ensureEpic(cwd, { goalText: 'do the thing', epicId: notAPromptSessionId });

  expect(result.created).toBe(true);
  expect(result.epicId).not.toBe(notAPromptSessionId);

  const index = readActiveIndex(cwd);
  expect(index.sessions[notAPromptSessionId]).toBeUndefined();
  expect(index.sessions[result.epicId]).toBeDefined();
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('ensureEpic joins the existing Epic when explicit epicId equals its promptSessionId', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'initial epic goal' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'a different PRD title', epicId: first.epicId });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);
  expect(second.prdDir).toBe(first.prdDir);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('removeEpic deletes a minted Epic from both sessions and events maps', async () => {
  const cwd = await mkCwd();
  const minted = await ensureEpic(cwd, { goalText: 'to be rolled back' });
  expect(readActiveIndex(cwd).sessions[minted.epicId]).toBeDefined();

  const removed = removeEpic(cwd, minted.epicId);

  expect(removed).toBe(true);
  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId]).toBeUndefined();
  expect(index.events[minted.epicId]).toBeUndefined();
});

test('removeEpic is a no-op (returns false) for an unknown epicId', async () => {
  const cwd = await mkCwd();
  await ensureEpic(cwd, { goalText: 'unrelated epic' });

  const removed = removeEpic(cwd, 'nonexistent-epic-id');

  expect(removed).toBe(false);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(1);
});

// A plain object's bracket lookup with a prototype-chain key like
// "__proto__"/"constructor" returns a truthy Object.prototype member even
// when no such Epic was ever written — without an own-property check, this
// would make mintIfMissing:false's "join an existing Epic" gate falsely
// report a match, defeating the restriction that a PRD write may only join
// a real, already-approved Epic.
for (const pollutedKey of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  test(`ensureEpic refuses to "join" the prototype-chain key "${pollutedKey}" (mintIfMissing:false)`, async () => {
    const cwd = await mkCwd();

    await expect(
      ensureEpic(cwd, { epicId: pollutedKey, mintIfMissing: false }),
    ).rejects.toThrow(/no existing Epic found/);

    const index = readActiveIndex(cwd);
    expect(Object.keys(index.sessions)).toHaveLength(0);
  });
}

test('removeEpic refuses to report success for the prototype-chain key "__proto__"', async () => {
  const cwd = await mkCwd();
  const removed = removeEpic(cwd, '__proto__');
  expect(removed).toBe(false);
});

test('ensureEpic persists the passed source onto the written active-index.json session record', async () => {
  const cwd = await mkCwd();
  const source = { producer: 'rca-hook', prdSlug: 'x', runId: 'y' };

  const minted = await ensureEpic(cwd, { goalText: 'auto-filed epic', source });

  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId].source).toEqual(source);
});

test('ensureEpic omits source from the written record when not passed', async () => {
  const cwd = await mkCwd();

  const minted = await ensureEpic(cwd, { goalText: 'human-filed epic' });

  const index = readActiveIndex(cwd);
  expect('source' in index.sessions[minted.epicId]).toBe(false);
});

test('ensureEpic joins an existing open Epic when goalText is a near-identical paraphrase (no preferEpicId)', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'Fix login button colour issue' });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('ensureEpic mints a distinct Epic when goalText is genuinely unrelated', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'Add CSV export to History tab' });

  expect(second.created).toBe(true);
  expect(second.epicId).not.toBe(first.epicId);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(2);
});

test('findJoinableEpic joins the preferEpicId Epic even when goalText similarity is near-zero', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const joined = findJoinableEpic(cwd, {
    goalText: 'Completely unrelated topic about database migrations',
    preferEpicId: first.epicId,
  });

  expect(joined).toEqual({ epicId: first.epicId, matchedBy: 'preferEpicId' });
});

test('findJoinableEpic falls through to the similarity check when preferEpicId points at a completed Epic', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  const index = readActiveIndex(cwd);
  index.sessions[first.epicId].status = 'completed';
  fs.writeFileSync(
    path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json'),
    JSON.stringify(index, null, 2),
  );

  // No other open Epic shares tokens with the completed one, so the
  // fall-through similarity check finds nothing rather than joining the
  // dead (completed) preferEpicId Epic.
  const joined = findJoinableEpic(cwd, { goalText: 'Fix login button colour issue', preferEpicId: first.epicId });

  expect(joined).toBeNull();
});

test('findJoinableEpic falls through to the similarity check when preferEpicId points at a nonexistent Epic, and can still find a match there', async () => {
  const cwd = await mkCwd();
  const sibling = await ensureEpic(cwd, { goalText: 'Fix the login button color' });

  const joined = findJoinableEpic(cwd, { goalText: 'Fix login button colour issue', preferEpicId: 'nonexistent-epic-id' });

  expect(joined).toEqual({ epicId: sibling.epicId, matchedBy: 'similarity', score: expect.any(Number) });
});

test('ensureEpic with forceNewEpic:true mints even when a near-identical open Epic exists', async () => {
  const cwd = await mkCwd();

  const first = await ensureEpic(cwd, { goalText: 'Fix the login button color' });
  expect(first.created).toBe(true);

  const second = await ensureEpic(cwd, { goalText: 'Fix login button colour issue', forceNewEpic: true });

  expect(second.created).toBe(true);
  expect(second.epicId).not.toBe(first.epicId);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(2);
});
