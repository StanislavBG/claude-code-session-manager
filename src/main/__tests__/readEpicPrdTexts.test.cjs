/**
 * readEpicPrdTexts — finds PRD text in live / archived / timestamped / ancestor dirs.
 * Run: timeout 120 npx vitest run src/main/__tests__/readEpicPrdTexts.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readEpicPrdTexts } = require('../scheduler/prdPaths.cjs');

const tmpDirs = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-read-epic-prds-'));
  tmpDirs.push(root);
  return root;
}
function epicDir(root, id = 'e1') {
  return path.join(root, 'session-manager-operations', 'scheduler', 'epics', id);
}
function put(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
}

test('finds live, archived and timestamped-archive files; bare slug resolves NN- prefix', async () => {
  const root = mk();
  const e = epicDir(root);
  put(path.join(e, 'prds'), '1-live-one.md', 'LIVE');
  put(path.join(e, 'prds-archived'), '2-arch-two.md', 'ARCH');
  put(path.join(e, 'prds-archived', '2026-10-01T00-00-00Z'), '3-ts-three.md', 'TS');
  const m = await readEpicPrdTexts(root, 'e1', ['live-one', '2-arch-two', 'ts-three', 'missing']);
  expect(m.get('live-one')).toBe('LIVE');
  expect(m.get('2-arch-two')).toBe('ARCH');
  expect(m.get('ts-three')).toBe('TS');
  expect(m.has('missing')).toBe(false);
});

test('exact name beats bare match; x does not match 872-fix-x', async () => {
  const root = mk();
  const e = epicDir(root);
  put(path.join(e, 'prds-archived'), '872-fix-x.md', 'NUM');
  put(path.join(e, 'prds-archived'), 'fix-x.md', 'EXACT');
  expect((await readEpicPrdTexts(root, 'e1', ['fix-x'])).get('fix-x')).toBe('EXACT');
  expect((await readEpicPrdTexts(root, 'e1', ['872-fix-x'])).get('872-fix-x')).toBe('NUM');
  fs.rmSync(path.join(e, 'prds-archived', 'fix-x.md'));
  const m = await readEpicPrdTexts(root, 'e1', ['fix-x', '872-fix-x', 'x']);
  expect(m.get('fix-x')).toBe('NUM');
  expect(m.get('872-fix-x')).toBe('NUM');
  expect(m.has('x')).toBe(false);
});

test('earlier dir wins over later; newest timestamp folder first', async () => {
  const root = mk();
  const e = epicDir(root);
  put(path.join(e, 'prds'), '5-dup.md', 'LIVE');
  put(path.join(e, 'prds-archived'), '5-dup.md', 'ARCH');
  put(path.join(e, 'prds-archived', '2026-01-01'), '6-old.md', 'OLD');
  put(path.join(e, 'prds-archived', '2026-02-01'), '6-old.md', 'NEW');
  const m = await readEpicPrdTexts(root, 'e1', ['dup', 'old']);
  expect(m.get('dup')).toBe('LIVE');
  expect(m.get('old')).toBe('NEW');
});

test('ancestor folder Epic is searched', async () => {
  const parent = mk();
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  put(path.join(epicDir(parent), 'prds-archived', '2026-01-01'), '7-anc.md', 'ANC');
  const m = await readEpicPrdTexts(repo, 'e1', ['anc']);
  expect(m.get('anc')).toBe('ANC');
});

test('bad inputs give an empty Map', async () => {
  const root = mk();
  put(path.join(epicDir(root), 'prds'), '1-a.md', 'A');
  expect((await readEpicPrdTexts(undefined, 'e1', ['a'])).size).toBe(0);
  expect((await readEpicPrdTexts(root, 'e1', [])).size).toBe(0);
  expect((await readEpicPrdTexts(root, 'e1', 'a')).size).toBe(0);
  expect((await readEpicPrdTexts(root, '../e1', ['a'])).size).toBe(0);
  expect((await readEpicPrdTexts(root, 'a/b', ['a'])).size).toBe(0);
  expect((await readEpicPrdTexts(root, '', ['a'])).size).toBe(0);
});

test('traversal slug is never joined into a path; symlinked entries skipped', async () => {
  const root = mk();
  const e = epicDir(root);
  put(path.join(e, 'prds'), '1-a.md', 'A');
  const m = await readEpicPrdTexts(root, 'e1', ['../../etc/passwd', '../prds/1-a']);
  expect(m.size).toBe(0);
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, 'SECRET');
  fs.symlinkSync(outside, path.join(e, 'prds', '2-link.md'));
  const m2 = await readEpicPrdTexts(root, 'e1', ['link', '2-link']);
  expect(m2.size).toBe(0);
});
