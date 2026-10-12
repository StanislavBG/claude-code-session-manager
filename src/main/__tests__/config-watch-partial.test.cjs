/**
 * config-watch-partial.test.cjs — watch() validates per path: an out-of-bounds
 * path is skipped (reported in `rejected`), the rest of the batch is watched.
 * Also covers activeSessions' sst-* tmp-cwd drop.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/config-watch-partial.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { isSstHarnessCwd } = require('../lib/activeSessions.cjs');

const cleanup = [];
afterEach(() => {
  config.closeAllWatchers();
  while (cleanup.length) fs.rmSync(cleanup.pop(), { recursive: true, force: true });
});

test('watch: bad path in the middle is rejected, valid paths on both sides are watched', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-watchpartial-')));
  cleanup.push(dir);
  config.addAllowedRoot(dir);
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  const bad = '/tmp/sst-base-1/x/active-index.json';

  const res = config.watch([a, bad, b], 1);
  expect(res.watched).toEqual([a, b]);
  expect(res.rejected).toEqual([bad]);

  // A repeat call still reports the rejection (warn is deduped, result is not).
  const again = config.watch([bad], 1);
  expect(again).toEqual({ watched: [], rejected: [bad] });
});

test('activeSessions: sst-* tmp cwd is dropped, non-sst tmp HOME cwd is kept', () => {
  const tmp = os.tmpdir();
  expect(isSstHarnessCwd(path.join(tmp, 'sst-base-1', 'proj'))).toBe(true);
  expect(isSstHarnessCwd(path.join(tmp, 'sst-base-1'))).toBe(true);
  expect(isSstHarnessCwd(path.join(tmp, 'sm-home-xyz', 'proj'))).toBe(false);
  expect(isSstHarnessCwd(path.join(tmp, 'proj', 'sst-nested'))).toBe(false);
  expect(isSstHarnessCwd(tmp)).toBe(false);
  expect(isSstHarnessCwd('/home/someone/proj')).toBe(false);
});
