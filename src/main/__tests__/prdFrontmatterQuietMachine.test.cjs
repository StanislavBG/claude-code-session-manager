/**
 * prdFrontmatterQuietMachine.test.cjs — PRD 1107: `quietMachine: true` is an
 * optional PRD frontmatter field, recognized by prdFrontmatter.cjs's
 * parsePrdFile/serializePrdFile round-trip AND by scheduler/prdParser.cjs's
 * dispatch-time parsePrdRaw. Only a literal `true` opts in; omitted or any
 * other value behaves exactly like today (additive-only, no required-field
 * regression for the thousands of PRDs written before this field existed).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterQuietMachine.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parsePrdFile, serializePrdFile } = require('../lib/prdFrontmatter.cjs');
const { parsePrdRaw, _resetCache } = require('../scheduler/prdParser.cjs');

function mkTmpPrdsDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-quietmachine-'));
}

test('parsePrdFile recognizes quietMachine: true and serializePrdFile round-trips it byte-identically', () => {
  const raw = [
    '---',
    'title: A timing-sensitive PRD',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 30',
    'quietMachine: true',
    '---',
    '# Goal',
    '',
    'Measure frame time without contention.',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  expect(frontmatter.quietMachine).toBe(true);
  expect(serializePrdFile(frontmatter, body)).toBe(raw);
});

test('parsePrdFile ignores quietMachine: false — only a literal true opts in', () => {
  const raw = [
    '---',
    'title: Not opted in',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 30',
    'quietMachine: false',
    '---',
    'body',
    '',
  ].join('\n');
  const { frontmatter } = parsePrdFile(raw);
  expect(frontmatter.quietMachine).toBeUndefined();
});

test('parsePrdFile leaves quietMachine undefined when omitted — additive-only, no regression for old PRDs', () => {
  const raw = [
    '---',
    'title: An older PRD authored before this field existed',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 30',
    '---',
    'body',
    '',
  ].join('\n');
  const { frontmatter } = parsePrdFile(raw);
  expect(frontmatter.quietMachine).toBeUndefined();
});

test('scheduler/prdParser.cjs parsePrdRaw exposes quietMachine as a typed boolean, true only when the frontmatter literally says true', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();

  const quietPath = path.join(dir, '1-quiet.md');
  await fsp.writeFile(quietPath, [
    '---',
    'title: Quiet job',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 10',
    'quietMachine: true',
    '---',
    '# Goal',
    '',
    'Do the thing quietly.',
    '',
  ].join('\n'));
  const quiet = await parsePrdRaw(quietPath);
  expect(quiet.quietMachine).toBe(true);

  const ordinaryPath = path.join(dir, '2-ordinary.md');
  await fsp.writeFile(ordinaryPath, [
    '---',
    'title: Ordinary job',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 10',
    '---',
    '# Goal',
    '',
    'Do the thing.',
    '',
  ].join('\n'));
  const ordinary = await parsePrdRaw(ordinaryPath);
  expect(ordinary.quietMachine).toBe(false);
});
