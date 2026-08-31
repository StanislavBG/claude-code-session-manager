/**
 * opsRootNestedWrite.test.cjs — writeSplit must never materialize a second
 * ops root beneath the first.
 *
 * Companion to opsRootAbsoluteCwd.test.cjs; separate file because HOME must
 * be overridden BEFORE requiring queueStore — MACHINE_STATE_PATH is baked
 * into a top-level const from os.homedir() at require time, and writeSplit
 * writes it on every call. (Learned the hard way: running this assertion in
 * the shared file overwrote the real ~/.claude/session-manager/
 * scheduler-machine.json, dropping the user's firePolicy and concurrencyCap.)
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/opsRootNestedWrite.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-opsroot-home-'));
process.env.HOME = tmpHome;

const queueStore = require('../queueStore.cjs');

const tmpDirs = [tmpHome];
afterEach(async () => {
  while (tmpDirs.length > 1) {
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

test('one ops-internal cwd in a write batch is skipped without losing the other projects', async () => {
  const good = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-opsroot-good-'));
  tmpDirs.push(good);
  const bad = path.join(good, 'session-manager-operations', 'scheduler', 'epics', 'e-1', 'prds');
  fs.mkdirSync(bad, { recursive: true });

  await queueStore.writeSplit({
    config: {},
    sourceCwds: [bad, good],
    jobs: [{ slug: 'keeper', cwd: good }, { slug: 'stray', cwd: bad }],
  });

  const written = JSON.parse(fs.readFileSync(queueStore.projectQueuePath(good), 'utf8'));
  expect(written.jobs.map((j) => j.slug)).toEqual(['keeper']);
  // The doubled-suffix stub the starry-night-ships report was about.
  expect(fs.existsSync(path.join(bad, 'session-manager-operations'))).toBe(false);
});
