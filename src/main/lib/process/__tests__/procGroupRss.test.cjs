/**
 * procGroupRss.test.cjs — fake /proc tree; no real processes involved.
 *
 * Run: timeout 120 npx vitest run src/main/lib/process/__tests__/procGroupRss.test.cjs
 */

'use strict';

import { test, afterEach } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { processGroupRssMb } = require('../procGroupRss.cjs');

let root;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// stat line: pid (comm) state ppid pgrp ... ; rss is field 24 (pages).
function statLine(pid, comm, pgrp, rssPages) {
  const rest = ['S', 1, pgrp, pgrp];
  while (rest.length < 21) rest.push(0); // fields 3..23
  rest.push(rssPages); // field 24
  rest.push(0);
  return `${pid} (${comm}) ${rest.join(' ')}\n`;
}

function fakeProc() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fakeproc-'));
  const add = (pid, comm, pgrp, rss) => {
    fs.mkdirSync(path.join(root, String(pid)));
    fs.writeFileSync(path.join(root, String(pid), 'stat'), statLine(pid, comm, pgrp, rss));
  };
  add(101, 'node', 100, 51200); // 200 MB at 4 KB pages
  add(102, '(a b) c)', 100, 25600); // 100 MB, nasty comm
  add(201, 'other', 200, 99999);
  fs.mkdirSync(path.join(root, '300')); // vanished: no stat file
  fs.mkdirSync(path.join(root, 'self')); // non-numeric
  return root;
}

test.skipIf(process.platform !== 'linux')('sums only the matching group, comm with parens ok', () => {
  const procRoot = fakeProc();
  assert.strictEqual(processGroupRssMb(100, { procRoot, pageSizeKb: 4 }), 300);
  assert.strictEqual(processGroupRssMb(200, { procRoot, pageSizeKb: 4 }), Math.floor((99999 * 4) / 1024));
});

test.skipIf(process.platform !== 'linux')('returns 0 for no match, bad pgid, missing root', () => {
  const procRoot = fakeProc();
  assert.strictEqual(processGroupRssMb(999, { procRoot }), 0);
  for (const bad of [0, -5, 1.5, NaN, '100', null, undefined]) {
    assert.strictEqual(processGroupRssMb(/** @type {any} */ (bad), { procRoot }), 0);
  }
  assert.strictEqual(processGroupRssMb(100, { procRoot: path.join(procRoot, 'nope') }), 0);
});
