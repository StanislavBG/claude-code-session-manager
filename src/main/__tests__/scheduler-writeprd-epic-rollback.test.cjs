/**
 * scheduler-writeprd-epic-rollback.test.cjs — PRD 851: when remote.writePrd
 * mints a brand-new Epic via ensureEpic (epicMint.cjs) but the PRD file write
 * itself then fails, cleanupEmptyMintedEpic must roll back BOTH the on-disk
 * empty epic dir AND the Epic's active-index.json entry (sessions/events) —
 * otherwise an orphaned seed-prompt-only Epic lingers forever in the Epics
 * nav with no PRDs and no cleanup path.
 *
 * The rollback must only fire for a call that minted a FRESH Epic
 * (ensureEpic's `created: true`); a PRD write that joins an existing Epic
 * and then fails must leave that Epic's history untouched.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-writeprd-epic-rollback.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { remote } = require('../scheduler.cjs');
const { ensureEpic, readActiveIndex } = require('../lib/epicMint.cjs');

const tmpDirs = [];

function makeFixtureCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-writeprd-epic-rollback-'));
  tmpDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A slug that escapes safeSlugPathIn's containment check, tripping the
// "invalid slug" branch of writePrd (scheduler.cjs ~4188-4191) after
// ensureEpic has already minted+persisted the Epic.
const ESCAPING_SLUG = '../escape-attempt';

test('writePrd: invalid-slug failure after a fresh Epic mint leaves zero residual active-index.json entries', async () => {
  const cwd = makeFixtureCwd();
  const body = '---\ntitle: Freshly minted epic goal\n---\n\nbody text\n';

  const result = await remote.writePrd(ESCAPING_SLUG, body, cwd);

  expect(result.ok).toBe(false);
  expect(result.error).toBe('invalid slug');

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(0);
  expect(Object.keys(index.events)).toHaveLength(0);
});

test('writePrd: invalid-slug failure when joining a pre-existing Epic leaves that Epic untouched', async () => {
  const cwd = makeFixtureCwd();

  const preexisting = ensureEpic(cwd, { goalText: 'pre-existing epic goal' });
  expect(preexisting.created).toBe(true);

  const beforeIndex = readActiveIndex(cwd);
  expect(Object.keys(beforeIndex.sessions)).toEqual([preexisting.epicId]);

  const body = `---\ntitle: Joins the existing epic\nsourcePromptId: ${preexisting.epicId}\n---\n\nbody text\n`;
  const result = await remote.writePrd(ESCAPING_SLUG, body, cwd);

  expect(result.ok).toBe(false);
  expect(result.error).toBe('invalid slug');

  const afterIndex = readActiveIndex(cwd);
  expect(Object.keys(afterIndex.sessions)).toEqual([preexisting.epicId]);
  expect(afterIndex.sessions[preexisting.epicId]).toEqual(beforeIndex.sessions[preexisting.epicId]);
  expect(afterIndex.events[preexisting.epicId]).toEqual(beforeIndex.events[preexisting.epicId]);
});
