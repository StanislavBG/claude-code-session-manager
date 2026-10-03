/**
 * prdSymlinkContainment.test.cjs — scheduler.remote's PRD read/update
 * handlers re-check containment against realPrdsDir(dir): a symlinked
 * `epics/<id>/prds` dir (a rogue job pointing it at e.g. ~/.claude) must be
 * rejected, while a project under a symlinked ancestor (macOS os.tmpdir():
 * /var → /private/var) must still resolve.
 *
 * Run: npx vitest run src/main/__tests__/prdSymlinkContainment.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let config;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-symlink-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
  config = require('../config.cjs');

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const slugDir = path.join(tmpHome, '.claude', 'projects', `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
  config.addAllowedRoot(cwd);
  const schedDir = path.join(cwd, 'session-manager-operations', 'scheduler');
  fs.mkdirSync(path.join(schedDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(schedDir, 'state', 'queue.json'), JSON.stringify({ jobs: [] }), 'utf8');
  fs.mkdirSync(path.join(schedDir, 'epics', 'test-epic-1'), { recursive: true });
  queueStore.bustCwdCache();
  return { cwd, prdsDir: path.join(schedDir, 'epics', 'test-epic-1', 'prds') };
}

function prdText(cwd) {
  return `---\ntitle: t\ncwd: ${cwd}\nestimateMinutes: 10\ncreatedVia: scheduler-api\n---\n\n# Goal\nDo the thing.\n`;
}

test('a real prds dir under a symlinked ancestor (os.tmpdir) still resolves', async () => {
  const { cwd, prdsDir } = makeProject('sm-prd-symlink-ok-');
  fs.mkdirSync(prdsDir, { recursive: true });
  fs.writeFileSync(path.join(prdsDir, 'plain.md'), prdText(cwd), 'utf8');

  const read = await scheduler.remote.readPrd('plain', cwd);
  expect(read.ok).toBe(true);
  const parsed = await scheduler.remote.getPrdParsed('plain', cwd);
  expect(parsed.ok).toBe(true);
});

test('a prds dir that is itself a symlink to an outside dir is rejected by read, parse and update', async () => {
  const { cwd, prdsDir } = makeProject('sm-prd-symlink-evil-');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-symlink-outside-'));
  const victim = path.join(outside, 'victim.md');
  fs.writeFileSync(victim, prdText(cwd), 'utf8');
  fs.symlinkSync(outside, prdsDir, 'dir');
  const before = fs.readFileSync(victim, 'utf8');

  expect(await scheduler.remote.readPrd('victim', cwd)).toMatchObject({ ok: false, error: 'invalid slug' });
  expect(await scheduler.remote.getPrdParsed('victim', cwd)).toMatchObject({ ok: false });
  const upd = await scheduler.remote.updatePrd({ slug: 'victim', cwd, body: '# Goal\nOverwritten.\n' });
  expect(upd.ok).toBe(false);
  expect(fs.readFileSync(victim, 'utf8')).toBe(before);

  fs.rmSync(outside, { recursive: true, force: true });
});
