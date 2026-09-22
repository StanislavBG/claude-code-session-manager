/**
 * configWriteBoundaryOwners.test.cjs — validateWrite's ops-subtree exemption
 * (config.cjs ~line 166) must derive its writable-namespace list from
 * opsOwnership.cjs's OWNERS map, not a separately hand-maintained array. PRD
 * 1398 declared 'ui-prefs' owned in OWNERS but config.cjs's own array was
 * never updated, so every real ui-prefs write threw "Write outside allowed
 * write boundaries" before assertOpsWrite's per-writer check ever ran (PRD
 * 1410). This test exercises the REAL validateWrite (via writeJson) for
 * every OWNERS namespace so that class of drift can never reoccur silently.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/configWriteBoundaryOwners.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { OWNERS } = require('../lib/opsOwnership.cjs');

// Real-homedir-rooted (not os.tmpdir()) so the fixture root is classified as
// a plain project, not an ephemeral cwd — opsPath() throws for roots under
// os.tmpdir(), which would make every namespace's exemption silently
// evaporate (opsSubs = []) and the test would pass for the wrong reason. Same
// pattern as prdCreate.test.cjs's real-homedir-rooted tests.
const roots = [];
afterEach(async () => {
  while (roots.length) {
    const r = roots.pop();
    await fsp.rm(r, { recursive: true, force: true });
  }
});

async function mkProjectRoot(tag) {
  const root = await fsp.mkdtemp(path.join(os.homedir(), `.sm-configwriteboundary-${tag}-`));
  config.addAllowedRoot(root);
  roots.push(root);
  return root;
}

for (const [namespace, owner] of Object.entries(OWNERS)) {
  test(`OWNERS namespace '${namespace}' is writable by its declared owner '${owner}'`, async () => {
    const root = await mkProjectRoot(namespace);
    const target = path.join(root, 'session-manager-operations', namespace, 'probe.json');
    const result = await config.writeJson(target, { probe: 1 }, { writer: owner });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });
}

test('a namespace not declared in OWNERS is still rejected', async () => {
  const root = await mkProjectRoot('undeclared');
  const target = path.join(root, 'session-manager-operations', 'not-a-real-namespace', 'probe.json');
  await expect(config.writeJson(target, { probe: 1 }, { writer: 'anyone' }))
    .rejects.toThrow(/Write outside allowed write boundaries/);
});
