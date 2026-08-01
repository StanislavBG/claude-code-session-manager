/**
 * chat-dead-channels.test.cjs — regression guard for the removed
 * chat:probe-context / chat:context-usage channels (PRD 897).
 *
 * These IPC channels were deliberately deleted (handler, broadcast, preload
 * and zod schema all removed) rather than left half-wired. This test walks
 * the source tree and fails if either literal string reappears anywhere
 * under src/main, src/preload, or src/renderer — such a reintroduction must
 * be wired end-to-end (handler + preload + zod schema + broadcast) or not
 * added at all.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/chat-dead-channels.test.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

import { test, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRS = ['src/main', 'src/preload', 'src/renderer'];
const FORBIDDEN_STRINGS = ['chat:probe-context', 'chat:context-usage'];
const SELF_PATH = path.resolve(__filename);

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else {
      files.push(full);
    }
  }
}

test('chat:probe-context / chat:context-usage channels stay removed', () => {
  const files = [];
  for (const dir of SCAN_DIRS) {
    walk(path.join(REPO_ROOT, dir), files);
  }

  const hits = [];
  for (const file of files) {
    if (path.resolve(file) === SELF_PATH) continue;
    const contents = fs.readFileSync(file, 'utf8');
    for (const needle of FORBIDDEN_STRINGS) {
      if (contents.includes(needle)) {
        hits.push(`${path.relative(REPO_ROOT, file)}: contains "${needle}"`);
      }
    }
  }

  expect(
    hits,
    'chat:probe-context / chat:context-usage were deliberately removed as a dead/half-wired ' +
      'channel (PRD 897). If reintroducing this feature, wire it end-to-end (handler, preload, ' +
      'zod schema, broadcast) in the same change — do not add just one side.\n' + hits.join('\n'),
  ).toEqual([]);
});
