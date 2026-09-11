/**
 * epicMintTelemetryTap.test.cjs — ensureEpic() fires the 'epic.create'
 * counter exactly once on a genuine mint (created: true), and not when an
 * existing open Epic is joined instead.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epicMintTelemetryTap.test.cjs
 */
'use strict';

import { test, expect, afterEach, beforeEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const countersPath = require.resolve('../lib/telemetryCounters.cjs');
const epicMintPath = require.resolve('../lib/epicMint.cjs');

let calls;
const tmpDirs = [];

beforeEach(() => {
  calls = [];
  require.cache[countersPath] = {
    id: countersPath,
    filename: countersPath,
    loaded: true,
    exports: { trackEpicCreate: () => calls.push(true) },
  };
  delete require.cache[epicMintPath];
});

afterEach(async () => {
  delete require.cache[countersPath];
  delete require.cache[epicMintPath];
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkCwd() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-epicmint-telemetry-cwd-'));
  tmpDirs.push(cwd);
  return cwd;
}

test('a genuine mint fires epic.create exactly once', async () => {
  const { ensureEpic, MINT_AUTHORITY_NEW_EPIC_UI } = require('../lib/epicMint.cjs');
  const cwd = await mkCwd();
  const result = await ensureEpic(cwd, { mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, goalText: 'do the thing' });
  expect(result.created).toBe(true);
  expect(calls).toEqual([true]);
});

test('joining an existing open Epic does NOT fire epic.create', async () => {
  const { ensureEpic, MINT_AUTHORITY_NEW_EPIC_UI } = require('../lib/epicMint.cjs');
  const cwd = await mkCwd();
  const minted = await ensureEpic(cwd, { mintAuthority: MINT_AUTHORITY_NEW_EPIC_UI, goalText: 'do the thing' });
  calls.length = 0;

  const joined = await ensureEpic(cwd, { epicId: minted.epicId, goalText: 'do the thing' });
  expect(joined.created).toBe(false);
  expect(calls).toEqual([]);
});
