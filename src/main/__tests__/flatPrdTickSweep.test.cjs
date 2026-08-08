/**
 * flatPrdTickSweep.test.cjs — the retired flat `scheduler/prds/` dir must be
 * TRULY inert, not just documented as such.
 *
 * Prior to this PRD, `runPrdMigration()`'s consolidation of the flat dir into
 * `prds-archived/` ran ONLY at Electron boot (src/main/scheduler.cjs). But
 * `prdLocations.cjs`'s `resolvePrdsDirs()` unconditionally keeps scanning the
 * flat dir as a live PRD source, and `reconcile()` runs on every tick — so a
 * PRD hand-written into the flat dir *after* boot sat there live and WOULD
 * get reconciled into a pending job and executed (observed 2026-08-07:
 * 1021/1022 PRDs in social-signals-trader executed once their status was
 * repaired), contradicting the develop skill's documented claim that
 * anything landed there is "auto-consolidated ... WITHOUT being executed."
 *
 * The fix: `consolidateAllFlatPrds()` now also runs at the START of every
 * `reconcile()` call itself (not just one caller like tickQueue's poll — every
 * caller of reconcile gets the guarantee), BEFORE reconcile scans the flat
 * dir. A freshly hand-written PRD has no queue row yet (reconcile hasn't
 * seen it), so it is never in LIVE_JOB_STATUSES — this sweep archives it
 * before reconcile ever gets a chance to turn it into a job. This test
 * proves that invariant directly against `consolidateAllFlatPrds`: a file
 * with no matching queue job is swept into `prds-archived/` on the very next
 * call, which prdLocations.cjs's `resolvePrdsDirs()` never scans as a live
 * source — so it can never be reconciled into a job afterward.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/flatPrdTickSweep.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { consolidateAllFlatPrds } = require('../scheduler.cjs');
const { resolvePrdWriteDir, resolvePrdsDirs } = require('../lib/prdLocations.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

function newProjectRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-flat-tick-sweep-'));
  tmpDirs.push(d);
  return d;
}

test('a PRD hand-written into the retired flat dir after boot is swept before it could ever be reconciled', async () => {
  const cwd = newProjectRoot();
  const flatDir = resolvePrdWriteDir(cwd);
  await fsp.mkdir(flatDir, { recursive: true });
  const filename = '999-hand-written-bypass.md';
  await fsp.writeFile(
    path.join(flatDir, filename),
    `---\ntitle: Hand-written bypass\ncwd: ${cwd}\nestimateMinutes: 10\n---\n\n# Goal\n\nSomething.\n`,
    'utf8',
  );
  // No queue.json at all yet — this is exactly the state of a PRD dropped on
  // disk moments ago, before any reconcile() pass has scanned it into a job.

  await consolidateAllFlatPrds([cwd]);

  // Swept out of the live flat dir...
  expect(fs.existsSync(path.join(flatDir, filename))).toBe(false);
  // ...and into prds-archived/, which resolvePrdsDirs() never returns as a
  // scan source — so no future reconcile() pass can find it and queue it.
  const archivedPath = path.join(path.dirname(flatDir), 'prds-archived', filename);
  expect(fs.existsSync(archivedPath)).toBe(true);

  const liveDirs = resolvePrdsDirs(Infinity, { projectsDir: path.join(cwd, '.nonexistent') });
  expect(liveDirs.every((d) => !d.includes('prds-archived'))).toBe(true);
});

test('consolidateAllFlatPrds still protects a PRD that already has a live queue job (PRD 992 invariant preserved)', async () => {
  const cwd = newProjectRoot();
  const flatDir = resolvePrdWriteDir(cwd);
  await fsp.mkdir(flatDir, { recursive: true });
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(
    path.join(flatDir, '998-live.md'),
    `---\ntitle: Live\ncwd: ${cwd}\nestimateMinutes: 10\n---\n\n# Goal\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(stateDir, 'queue.json'),
    JSON.stringify({ jobs: [{ slug: '998-live', status: 'running' }] }),
    'utf8',
  );

  await consolidateAllFlatPrds([cwd]);

  expect(fs.existsSync(path.join(flatDir, '998-live.md'))).toBe(true);
});

test('consolidateAllFlatPrds never throws when a project errors — one bad cwd does not block the sweep of the rest', async () => {
  const good = newProjectRoot();
  const flatDir = resolvePrdWriteDir(good);
  await fsp.mkdir(flatDir, { recursive: true });
  await fsp.writeFile(path.join(flatDir, '997-ok.md'), `---\ntitle: Ok\ncwd: ${good}\nestimateMinutes: 5\n---\n\n# Goal\n`, 'utf8');

  await expect(consolidateAllFlatPrds([null, good])).resolves.toBeUndefined();

  expect(fs.existsSync(path.join(flatDir, '997-ok.md'))).toBe(false);
});
