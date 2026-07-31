/**
 * scheduler-find-prd-dir.test.cjs — unit test for findPrdDir's legacy-dir
 * fallback (PRD 812 split-brain fix): a PRD slug that exists only in the
 * legacy global `~/.claude/session-manager/scheduled-plans/prds/` dir (not
 * yet migrated into any project's own
 * `<cwd>/session-manager-operations/scheduler/prds/`) must still resolve,
 * since findPrdDir's candidatePrdsDirs() searches the legacy dir first.
 *
 * Touches the real legacy PRDS_DIR (scheduler.cjs hard-codes it from
 * os.homedir(), same as other scheduler unit tests that exercise
 * global-path-backed exports) with a unique slug, and cleans up after itself.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-find-prd-dir.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findPrdDir, PRDS_DIR } = require('../scheduler.cjs');

test('findPrdDir resolves a slug that exists only in the legacy global PRDs dir', async () => {
  const slug = `812-test-legacy-only-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const legacyPath = path.join(PRDS_DIR, `${slug}.md`);
  fs.mkdirSync(PRDS_DIR, { recursive: true });
  fs.writeFileSync(legacyPath, '---\ntitle: legacy fixture\n---\n\n# Goal\n\ntest\n', 'utf8');

  try {
    const dir = await findPrdDir(slug);
    expect(dir).toBe(PRDS_DIR);
  } finally {
    fs.rmSync(legacyPath, { force: true });
  }
});

test('findPrdDir returns null for a slug that exists nowhere', async () => {
  const slug = `812-test-nonexistent-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const dir = await findPrdDir(slug);
  expect(dir).toBe(null);
});
