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
const { ensureEpic, removeEpic, readActiveIndex } = require('../lib/epicMint.cjs');

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

  const result = ensureEpic(cwd, { goalText: 'do the thing', epicId: notAPromptSessionId });

  expect(result.created).toBe(true);
  expect(result.epicId).not.toBe(notAPromptSessionId);

  const index = readActiveIndex(cwd);
  expect(index.sessions[notAPromptSessionId]).toBeUndefined();
  expect(index.sessions[result.epicId]).toBeDefined();
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('ensureEpic joins the existing Epic when explicit epicId equals its promptSessionId', async () => {
  const cwd = await mkCwd();

  const first = ensureEpic(cwd, { goalText: 'initial epic goal' });
  expect(first.created).toBe(true);

  const second = ensureEpic(cwd, { goalText: 'a different PRD title', epicId: first.epicId });

  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);
  expect(second.prdDir).toBe(first.prdDir);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(1);
});

test('removeEpic deletes a minted Epic from both sessions and events maps', async () => {
  const cwd = await mkCwd();
  const minted = ensureEpic(cwd, { goalText: 'to be rolled back' });
  expect(readActiveIndex(cwd).sessions[minted.epicId]).toBeDefined();

  const removed = removeEpic(cwd, minted.epicId);

  expect(removed).toBe(true);
  const index = readActiveIndex(cwd);
  expect(index.sessions[minted.epicId]).toBeUndefined();
  expect(index.events[minted.epicId]).toBeUndefined();
});

test('removeEpic is a no-op (returns false) for an unknown epicId', async () => {
  const cwd = await mkCwd();
  ensureEpic(cwd, { goalText: 'unrelated epic' });

  const removed = removeEpic(cwd, 'nonexistent-epic-id');

  expect(removed).toBe(false);
  expect(Object.keys(readActiveIndex(cwd).sessions)).toHaveLength(1);
});
