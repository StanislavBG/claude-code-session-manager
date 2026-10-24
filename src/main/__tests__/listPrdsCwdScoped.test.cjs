/**
 * listPrdsCwdScoped.test.cjs — remote.listPrds({ cwd }) reads only that
 * project's PRD dirs instead of scanning every project on the machine.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/listPrdsCwdScoped.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let projA;
let projB;

function prdText(cwd, title) {
  return `---\ntitle: ${title}\ncwd: ${cwd}\nestimateMinutes: 10\nsourcePromptId: ep\ncreatedVia: scheduler-api\nissuedAt: 2026-09-25T00:00:00.000Z\n---\n\n# Goal\n\nSomething.\n`;
}

function makeProject(prefix, tag) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const epicRoot = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', 'ep1');
  fs.mkdirSync(path.join(epicRoot, 'prds'), { recursive: true });
  fs.mkdirSync(path.join(epicRoot, 'prds-archived'), { recursive: true });
  fs.writeFileSync(path.join(epicRoot, 'prds', `${tag}-live.md`), prdText(cwd, `${tag} live`), 'utf8');
  fs.writeFileSync(path.join(epicRoot, 'prds-archived', `${tag}-old.md`), prdText(cwd, `${tag} old`), 'utf8');
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), `${JSON.stringify({ cwd })}\n`);
  return cwd;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-listprds-scoped-home-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME`);
  }
  projA = makeProject('sm-listprds-a-', 'alpha');
  projB = makeProject('sm-listprds-b-', 'beta');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(projA, { recursive: true, force: true });
  fs.rmSync(projB, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('listPrds({ cwd }) returns exactly that project\'s live + archived PRDs', async () => {
  const res = await scheduler.remote.listPrds({ cwd: projA, fields: 'full', limit: Number.MAX_SAFE_INTEGER });
  const got = res.prds.map((p) => [p.slug, p.archived]).sort();
  expect(got).toEqual([['alpha-live', false], ['alpha-old', true]]);
  expect(res.total).toBe(2);
});

test('listPrds({ cwd: A }) never readdirs under B; listPrds({}) still returns both', async () => {
  const spy = vi.spyOn(fsp, 'readdir');
  await scheduler.remote.listPrds({ cwd: projA });
  const touched = spy.mock.calls.map((c) => String(c[0]));
  expect(touched.filter((p) => p.startsWith(projB))).toEqual([]);
  spy.mockRestore();

  const all = await scheduler.remote.listPrds({ fields: 'full', limit: Number.MAX_SAFE_INTEGER });
  const slugs = all.prds.map((p) => p.slug);
  for (const s of ['alpha-live', 'alpha-old', 'beta-live', 'beta-old']) expect(slugs).toContain(s);
});
