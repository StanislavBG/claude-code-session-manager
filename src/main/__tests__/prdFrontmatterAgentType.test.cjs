/**
 * prdFrontmatterAgentType.test.cjs — PRD 1114: `agentType` (WHO executes a
 * PRD, distinct from `tag` — the WORK TYPE) is a recognized PRD frontmatter
 * key, round-tripped byte-identically by prdFrontmatter.cjs's
 * parsePrdFile/serializePrdFile pair, and surfaced (with read-time tolerance
 * for a dangling persona) by scheduler/prdParser.cjs's parsePrdRaw.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterAgentType.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parsePrdFile, serializePrdFile } = require('../lib/prdFrontmatter.cjs');
const { parsePrdRaw, _resetCache } = require('../scheduler/prdParser.cjs');
const { todayFile } = require('../lib/opsErrorLog.cjs');

function mkTmpPrdsDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-agenttype-fm-'));
}

test('parsePrdFile recognizes agentType and serializePrdFile round-trips it byte-identically', () => {
  const raw = [
    '---',
    'title: A PRD with a persona',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 30',
    'tag: bug',
    'agentType: dev-lead',
    '---',
    '# Goal',
    '',
    'Fix the thing.',
    '',
  ].join('\n');

  const { frontmatter, body } = parsePrdFile(raw);
  expect(frontmatter.agentType).toBe('dev-lead');
  expect(serializePrdFile(frontmatter, body)).toBe(raw);
});

test('parsePrdFile leaves agentType undefined when omitted — additive-only, no regression for old PRDs', () => {
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
  expect(frontmatter.agentType).toBeUndefined();
});

// Real opsErrorLog write path (not a mock) — see prdAgentType.test.cjs's
// header for why a plain mkdtemp() cwd is safe to use here (not "ephemeral").
test('scheduler/prdParser.cjs parsePrdRaw exposes agentType, and tolerates a dangling persona by logging once instead of throwing', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();

  const danglingPath = path.join(dir, '1-dangling.md');
  await fsp.writeFile(danglingPath, [
    '---',
    'title: A PRD whose persona was later deleted',
    `cwd: ${dir}`,
    'estimateMinutes: 10',
    'agentType: ghost-persona-that-does-not-exist-anywhere',
    '---',
    '# Goal',
    '',
    'Still loads.',
    '',
  ].join('\n'));

  const parsed = await parsePrdRaw(danglingPath);
  expect(parsed.agentType).toBe('ghost-persona-that-does-not-exist-anywhere');

  const lines = fs.readFileSync(todayFile(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const matches = lines.filter((l) => l.message.includes('ghost-persona-that-does-not-exist-anywhere'));
  expect(matches).toHaveLength(1);
  expect(matches[0].scope).toBe('prdAgentType');
  expect(matches[0].level).toBe('warn');

  // A second parse of the SAME (cwd, agentType) pair must not log again.
  _resetCache();
  await parsePrdRaw(danglingPath);
  const linesAfter = fs.readFileSync(todayFile(dir), 'utf8').split('\n').filter(Boolean);
  expect(linesAfter).toHaveLength(1);
});

test('scheduler/prdParser.cjs parsePrdRaw leaves agentType null when omitted', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();

  const ordinaryPath = path.join(dir, '2-ordinary.md');
  await fsp.writeFile(ordinaryPath, [
    '---',
    'title: Ordinary job',
    `cwd: ${dir}`,
    'estimateMinutes: 10',
    '---',
    '# Goal',
    '',
    'Do the thing.',
    '',
  ].join('\n'));

  const parsed = await parsePrdRaw(ordinaryPath);
  expect(parsed.agentType).toBeNull();
});
