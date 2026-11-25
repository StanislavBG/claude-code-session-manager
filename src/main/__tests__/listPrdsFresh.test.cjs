/**
 * listPrdsFresh.test.cjs — remote.listPrds({ fresh: true }) bypasses the
 * single-flight listPrdsShared and calls listPrdsInternal directly, so the
 * PRD-create cross-Epic guard never reuses a scan that began before another
 * create's write (2026-11-24: Bilko PRD 2005 duplicated 2001).
 *
 * HOME is overridden BEFORE requiring scheduler.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/listPrdsFresh.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let cwd;
let prdsDir;

const EPIC = 'fresh-read-epic';
const SEEDED = ['fr-one', 'fr-two'];

function prdBody(slug) {
  return `---\ntitle: ${slug}\ncwd: ${cwd}\nestimateMinutes: 10\nepicId: ${EPIC}\nsourcePromptId: ${EPIC}\n---\n\n# Goal\n\nx\n`;
}

beforeAll(async () => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-list-prds-fresh-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
  cwd = path.join(tmpHome, 'proj');
  prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', EPIC, 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  for (const slug of SEEDED) fs.writeFileSync(path.join(prdsDir, `${slug}.md`), prdBody(slug));
  const projDir = path.join(tmpHome, '.claude', 'projects', 'fake-project-slug');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd })}\n`);
  await scheduler.writeQueue({ jobs: [], config: {}, paused: null });
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const slugsOf = (res) => res.prds.map((p) => p.slug).sort();

test('non-fresh read joins the single-flight; fresh read bypasses it; same slugs', async () => {
  const inFlight = scheduler.listPrdsShared.inFlight;
  expect(inFlight.size).toBe(0);

  const shared = scheduler.remote.listPrds({ cwd });
  expect(inFlight.size).toBe(1);
  const sharedRes = await shared;
  expect(inFlight.size).toBe(0);

  const fresh = scheduler.remote.listPrds({ cwd, fresh: true });
  expect(inFlight.size).toBe(0);
  const freshRes = await fresh;
  expect(inFlight.size).toBe(0);

  // The string 'true' is not the opt-in — it stays on the shared path.
  const stringTrue = scheduler.remote.listPrds({ cwd, fresh: 'true' });
  expect(inFlight.size).toBe(1);
  const stringRes = await stringTrue;

  expect(slugsOf(sharedRes)).toEqual(SEEDED);
  expect(slugsOf(freshRes)).toEqual(SEEDED);
  expect(slugsOf(stringRes)).toEqual(SEEDED);
  expect(freshRes.total).toBe(sharedRes.total);
});

test('a PRD file written straight into the Epic prds/ folder is returned at once by a fresh full read', async () => {
  const slug = 'fr-just-written';
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), prdBody(slug));
  const res = await scheduler.remote.listPrds({ cwd, fields: 'full', fresh: true });
  const entry = res.prds.find((p) => p.slug === slug);
  expect(entry, slug).toBeTruthy();
  expect(entry.epicId).toBe(EPIC);
  expect(entry.status).toBeNull();
  expect(scheduler.listPrdsShared.inFlight.size).toBe(0);
});
