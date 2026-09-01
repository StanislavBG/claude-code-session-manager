/**
 * epicStatusMirror.test.cjs — every write path that changes an Epic's status
 * in active-index.json must leave the SAME status mirrored onto
 * prompt-sessions/<id>.json (epicStatusMirror.cjs), so a lost/clobbered index
 * can be reconstructed (activeIndexRebuild.cjs) without silently erasing
 * open Epics.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/epicStatusMirror.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureEpic, removeEpic, readActiveIndex, MINT_AUTHORITY_NEW_EPIC_UI } = require('../lib/epicMint.cjs');
const { mergeActiveIndex } = require('../lib/activeIndexMerge.cjs');
const { epicMirrorPath } = require('../lib/epicStatusMirror.cjs');
const config = require('../config.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-statusmirror-cwd-'));
  config.addAllowedRoot(cwd);
  tmpDirs.push(cwd);
  return cwd;
}

function readMirror(cwd, epicId) {
  return JSON.parse(fs.readFileSync(epicMirrorPath(cwd, epicId), 'utf8'));
}

test('minting an Epic leaves the file\'s status equal to the index row\'s', async () => {
  const cwd = await mkCwd();

  const { epicId } = await ensureEpic(cwd, {
    goalText: 'a fresh Epic',
    mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI,
  });

  const index = readActiveIndex(cwd);
  const mirror = readMirror(cwd, epicId);
  expect(mirror.status).toBe(index.sessions[epicId].status);
  expect(mirror.status).toBe('proposed');
  expect(mirror.cwd).toBe(cwd);
  expect(mirror.goalText).toBe('a fresh Epic');
  expect(typeof mirror.indexedAt).toBe('string');
  expect(mirror.archivedAt).toBeNull();
});

test('the approve/start transition (mergeActiveIndex) updates the file\'s status to match', async () => {
  const cwd = await mkCwd();
  const { epicId } = await ensureEpic(cwd, {
    goalText: 'to be started',
    mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI,
  });

  const proposedIndex = readActiveIndex(cwd);
  const activated = { ...proposedIndex.sessions[epicId], status: 'active' };
  await mergeActiveIndex(cwd, {
    sessions: { [epicId]: activated },
    events: proposedIndex.events,
  });

  const index = readActiveIndex(cwd);
  const mirror = readMirror(cwd, epicId);
  expect(index.sessions[epicId].status).toBe('active');
  expect(mirror.status).toBe('active');
  expect(mirror.status).toBe(index.sessions[epicId].status);
});

test('removeEpic (mint rollback) deletes the mirror file too, leaving no orphan', async () => {
  const cwd = await mkCwd();
  const { epicId } = await ensureEpic(cwd, {
    goalText: 'will be rolled back',
    mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI,
  });
  expect(fs.existsSync(epicMirrorPath(cwd, epicId))).toBe(true);

  await removeEpic(cwd, epicId);

  expect(fs.existsSync(epicMirrorPath(cwd, epicId))).toBe(false);
  expect(readActiveIndex(cwd).sessions[epicId]).toBeUndefined();
});

test('a merge that tombstones an Epic leaves its prior mirror file in place (rebuild excludes it via the tombstone, not file deletion)', async () => {
  const cwd = await mkCwd();
  const { epicId } = await ensureEpic(cwd, {
    goalText: 'to be removed',
    mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI,
  });

  await mergeActiveIndex(cwd, { sessions: {}, events: {}, removedIds: [epicId] });

  const index = readActiveIndex(cwd);
  expect(index.sessions[epicId]).toBeUndefined();
  expect(index.tombstones[epicId]).toBeDefined();
  // The mirror file is untouched — activeIndexRebuild.cjs is what must keep
  // this id out, by consulting tombstones, not by the file being gone.
  expect(fs.existsSync(epicMirrorPath(cwd, epicId))).toBe(true);
});
