/**
 * prdCreateCrossEpicNoReconcile.test.cjs — both cross-Epic checks in
 * prdCreate.cjs (the same-slug 409 guard and the files-overlap advisory) must
 * see a PRD another Epic wrote moments ago, before any reconcile pass gave it
 * a queue row (2026-11-24 Bilko: 2005 named the same files as 2001 and got no
 * overlap warning). Runs against the REAL scheduler.remote; Epic A's PRD is a
 * plain file under epics/<epicA>/prds/ with no queue row, so listPrds gives it
 * status null.
 *
 * HOME is overridden BEFORE requiring scheduler.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/prdCreateCrossEpicNoReconcile.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EPIC_A = 'sync-drop-record-push-epic-a-11111111';
const EPIC_B = 'sync-drop-record-push-epic-b-22222222';
const SLUG_A = '2001-sync-drop-record-push';
const FILE = 'scripts/sync-local-main.sh';

let tmpHome;
let originalHome;
let scheduler;
let config;
let createPrd;
let createPrdBatch;
let projSeq = 0;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cross-epic-no-reconcile-'));
  process.env.HOME = tmpHome;
  scheduler = require('../scheduler.cjs');
  config = require('../config.cjs');
  ({ createPrd, createPrdBatch } = require('../lib/prd/prdCreate.cjs'));
  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) throw new Error('PRDS_DIR not under temp HOME');
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const epicPrdsDir = (cwd, epic) => path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epic, 'prds');

/** A fresh project per test: two active Epics + Epic A's unreconciled PRD file. */
function makeProject() {
  const cwd = path.join(tmpHome, `proj-${++projSeq}`);
  const psDir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(psDir, { recursive: true });
  const now = new Date().toISOString();
  const sess = (id) => ({ id, status: 'active', cwd, title: id, createdAt: now, updatedAt: now });
  fs.writeFileSync(path.join(psDir, 'active-index.json'),
    JSON.stringify({ sessions: { [EPIC_A]: sess(EPIC_A), [EPIC_B]: sess(EPIC_B) }, events: {} }, null, 2));
  const dirA = epicPrdsDir(cwd, EPIC_A);
  fs.mkdirSync(dirA, { recursive: true });
  fs.writeFileSync(path.join(dirA, `${SLUG_A}.md`),
    `---\ntitle: Sync drop record push\ncwd: ${cwd}\nsourcePromptId: ${EPIC_A}\ncreatedVia: scheduler-api\nissuedAt: ${now}\n---\n\n` +
    `# Goal\n\nDrop the record push.\n\n# Files\n\n- ${FILE}\n`);
  fs.mkdirSync(epicPrdsDir(cwd, EPIC_B), { recursive: true });
  config.addAllowedRoot(cwd);
  return cwd;
}

const entry = (slug, o = {}) => ({
  title: `T ${slug}`, slug, goal: 'g', acceptanceCriteria: ['a'],
  implementationNotes: 'n', gate: ['true'], files: [FILE], ...o,
});
const mdFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : []);
const overlapWarnings = (r) => (r?.warnings ?? []).filter((w) => w.startsWith(`Files overlap with ${SLUG_A}`));

test('fixture: Epic A\'s PRD is listed with status null (never reconciled)', async () => {
  const cwd = makeProject();
  const listing = await scheduler.remote.listPrds({ cwd, fields: 'full', limit: Number.MAX_SAFE_INTEGER });
  const row = (listing.prds ?? []).find((r) => r.slug === SLUG_A);
  expect(row).toBeTruthy();
  expect(row.epicId).toBe(EPIC_A);
  expect(row.status ?? null).toBeNull();
  expect(row.archived).toBe(false);
});

test('same-slug batch from Epic B is refused 409 naming 2001 and Epic A; nothing written', async () => {
  const cwd = makeProject();
  const r = await createPrdBatch([entry('sync-drop-record-push')], scheduler.remote, { cwd, sourcePromptId: EPIC_B });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(409);
  const msg = (r.errors ?? []).map((e) => e.error).join('\n');
  expect(msg).toContain(SLUG_A);
  expect(msg).toContain(EPIC_A);
  expect(mdFiles(epicPrdsDir(cwd, EPIC_B))).toEqual([]);
});

test('allowDuplicateOf lets the batch through, warning about the files overlap', async () => {
  const cwd = makeProject();
  const r = await createPrdBatch([entry('sync-drop-record-push', { allowDuplicateOf: [SLUG_A] })], scheduler.remote, { cwd, sourcePromptId: EPIC_B });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const results = r.results ?? r.prds;
  expect(results).toHaveLength(1);
  expect(overlapWarnings(results[0])).toHaveLength(1);
  expect(mdFiles(epicPrdsDir(cwd, EPIC_B))).toHaveLength(1);
});

test('createPrd in Epic B with a different slug and the same file warns', async () => {
  const cwd = makeProject();
  const r = await createPrd(entry('sync-push-guard', { cwd, sourcePromptId: EPIC_B }), scheduler.remote);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const w = overlapWarnings(r);
  expect(w).toHaveLength(1);
  expect(w[0]).toContain(EPIC_A);
  expect(w[0]).toContain(FILE);
});
