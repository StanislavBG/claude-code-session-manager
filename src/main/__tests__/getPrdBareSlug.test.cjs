/**
 * getPrdBareSlug.test.cjs — a bare slug (no NN- prefix) resolves to the unique
 * NN-prefixed PRD across live dirs, prds-archived/ and prds-archived/<ts>/.
 *
 * Run: npx vitest run src/main/__tests__/getPrdBareSlug.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prdPaths = require('../scheduler/prdPaths.cjs');

let cwd;
let prds;
let archived;

function put(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '---\ntitle: x\n---\n');
  return path.join(dir, name);
}

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bare-slug-'));
  const sched = path.join(cwd, 'session-manager-operations', 'scheduler');
  prds = path.join(sched, 'prds');
  archived = path.join(sched, 'prds-archived');
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

test('bare slug resolves to the unique NN-prefixed file (live, archived, <ts>/)', async () => {
  const live = put(prds, '163-attack-scorecard.md');
  expect((await prdPaths.resolveSlugOrReason('attack-scorecard', cwd))).toMatchObject({ ok: true, path: live });
  fs.rmSync(live);
  const flat = put(archived, '163-attack-scorecard.md');
  expect((await prdPaths.resolveSlugOrReason('attack-scorecard', cwd))).toMatchObject({ ok: true, path: flat });
  fs.rmSync(flat);
  const ts = put(path.join(archived, '2026-10-01T00-00-00'), '163-attack-scorecard.md');
  expect((await prdPaths.resolveSlugOrReason('attack-scorecard', cwd))).toMatchObject({ ok: true, path: ts });
});

test('exact NN-prefixed slug resolves as before', async () => {
  const live = put(prds, '163-attack-scorecard.md');
  put(archived, '164-attack-scorecard.md');
  expect(await prdPaths.resolveSlugOrReason('163-attack-scorecard', cwd)).toMatchObject({ ok: true, path: live });
  expect(await prdPaths.resolveSlugOrReason('999-nope', cwd)).toEqual({ ok: false, reason: 'not-found' });
});

test('two files matching one bare name return an error naming both', async () => {
  const a = put(prds, '163-attack-scorecard.md');
  const b = put(archived, '170-attack-scorecard.md');
  const r = await prdPaths.resolveSlugOrReason('attack-scorecard', cwd);
  expect(r.ok).toBe(false);
  expect(r.reason).toBe('ambiguous');
  expect(r.error).toContain(a);
  expect(r.error).toContain(b);
});
