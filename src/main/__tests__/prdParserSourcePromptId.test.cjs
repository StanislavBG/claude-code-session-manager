/**
 * prdParserSourcePromptId.test.cjs — parsePrdRaw() tolerates both presence
 * and absence of the optional `sourcePromptId` frontmatter key (PRD 749).
 * Additive-only: PRDs written before this field existed must still parse
 * identically (no required-field regression).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdParserSourcePromptId.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { parsePrdRaw, _resetCache } = require('../scheduler/prdParser.cjs');

function mkTmpPrdsDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-sourceprompt-'));
}

test('parsePrdRaw extracts sourcePromptId when present in frontmatter', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();
  const filePath = path.join(dir, '1-with-source.md');
  await fsp.writeFile(filePath, [
    '---',
    'title: Has a source ticket',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 10',
    'sourcePromptId: ticket-xyz-789',
    '---',
    '# Goal',
    '',
    'Do the thing.',
    '',
  ].join('\n'));

  const parsed = await parsePrdRaw(filePath);
  expect(parsed.sourcePromptId).toBe('ticket-xyz-789');
  expect(parsed.title).toBe('Has a source ticket');
});

test('parsePrdRaw returns null sourcePromptId for a PRD authored before this field existed', async () => {
  const dir = await mkTmpPrdsDir();
  _resetCache();
  const filePath = path.join(dir, '2-legacy.md');
  await fsp.writeFile(filePath, [
    '---',
    'title: Legacy PRD, no sourcePromptId',
    'cwd: ~/Projects/session-manager',
    'estimateMinutes: 5',
    '---',
    '# Goal',
    '',
    'Do the other thing.',
    '',
  ].join('\n'));

  const parsed = await parsePrdRaw(filePath);
  expect(parsed.sourcePromptId).toBe(null);
  expect(parsed.title).toBe('Legacy PRD, no sourcePromptId');
  expect(parsed.cwd).toBe(path.join(os.homedir(), 'Projects', 'session-manager'));
});
