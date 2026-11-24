/**
 * kitDocsLinked.test.cjs — every .md playbook seeded with the kit is linked from code-map.md,
 * so an unlinked kit doc fails the kit's own gate (cast.md once landed unlinked; fixed by ad3597eb).
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/kitDocsLinked.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { kitFiles } = require('../seedKit.cjs');

const CODE_MAP = path.join(__dirname, '..', '..', '..', '..', '..', 'session-manager-operations', 'architecture', 'code-map.md');
const LINK_PREFIX = '](../../src/main/lib/demo-video-kit/';

/** Pure: the .md names in `names` with no `](../../src/main/lib/demo-video-kit/<name>)` link in `codeMapText`. */
function unlinkedKitDocs(names, codeMapText) {
  return names.filter((n) => n.endsWith('.md') && !codeMapText.includes(`${LINK_PREFIX}${n})`));
}

function readCodeMap() {
  expect(fs.existsSync(CODE_MAP), `code-map.md not found at ${CODE_MAP}`).toBe(true);
  return fs.readFileSync(CODE_MAP, 'utf8');
}

test('every .md file in kitFiles() is linked from code-map.md', () => {
  const missing = unlinkedKitDocs(kitFiles(), readCodeMap());
  expect(
    missing,
    `Unlinked kit docs: ${missing.join(', ')} — link each from code-map.md's demo-video-kit bullet as [<name>](../../src/main/lib/demo-video-kit/<name>)`,
  ).toEqual([]);
});

test('a made-up kit doc is reported as unlinked, and only it', () => {
  const names = [...kitFiles(), 'kind-made-up-zz.md'];
  expect(unlinkedKitDocs(names, readCodeMap())).toEqual(['kind-made-up-zz.md']);
});
