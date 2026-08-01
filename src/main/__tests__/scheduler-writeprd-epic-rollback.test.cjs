/**
 * scheduler-writeprd-epic-rollback.test.cjs — remote.writePrd may only JOIN
 * an existing, already-human-approved Epic (via `sourcePromptId`); it must
 * never mint a new one (mintIfMissing:false, see epicMint.cjs's ensureEpic).
 * A write with no resolvable Epic fails outright with zero residual
 * active-index.json entries — no orphaned Epic can ever be left behind by
 * this path because none is ever created by it.
 *
 * A PRD write that joins a pre-existing Epic and then fails (e.g. an invalid
 * slug) must leave that Epic's history untouched.
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
// "invalid slug" branch of writePrd (scheduler.cjs's writePrd). Only the
// second test below (joining a pre-existing Epic) actually reaches this
// check — the first test fails earlier, at Epic resolution, before the slug
// is ever considered.
const ESCAPING_SLUG = '../escape-attempt';

test('writePrd: no sourcePromptId refuses to write (no Epic to join) and mints nothing', async () => {
  const cwd = makeFixtureCwd();
  const body = '---\ntitle: No epic given\n---\n\nbody text\n';

  const result = await remote.writePrd(ESCAPING_SLUG, body, cwd);

  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/no existing Epic to join/);

  const index = readActiveIndex(cwd);
  expect(Object.keys(index.sessions)).toHaveLength(0);
  expect(Object.keys(index.events)).toHaveLength(0);
});

test('writePrd: invalid-slug failure when joining a pre-existing Epic leaves that Epic untouched', async () => {
  const cwd = makeFixtureCwd();

  const preexisting = await ensureEpic(cwd, { goalText: 'pre-existing epic goal' });
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
