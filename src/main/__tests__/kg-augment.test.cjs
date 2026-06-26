'use strict';

/**
 * Unit test for kg exchange-pairing logic (kgExchangePairing.cjs).
 *
 * Verifies:
 *   1. When a prompt has a matching exchange record, the enriched entry includes
 *      result and summary from the exchange.
 *   2. When no exchange file exists for the cwd, entries fall back to prompt-only
 *      (no crash, no empty-graph wipe).
 *   3. When an exchange exists but the prompt text doesn't match, the entry is
 *      returned unchanged (no false enrichment).
 *   4. normalizePromptKey trims, lowercases, and collapses whitespace so minor
 *      differences between log sources don't break the match.
 *
 * Does NOT spawn claude -p. Run:
 *   timeout 120 node --test src/main/__tests__/kg-augment.test.cjs
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// ─── Tmp directory ───────────────────────────────────────────────────────────

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-augment-test-'));
});

after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshRequire(mod) {
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

const PAIRING_MOD = '../lib/kgExchangePairing.cjs';

/** Write NDJSON exchange records to a file under a fresh exchanges dir. */
async function writeExchangeFile(exchangesDir, cwd, records) {
  // Derive the encoded cwd the same way the module does
  const { encodeCwd } = require('../lib/encodeCwd.cjs');
  const encoded = encodeCwd(cwd);
  const filePath = path.join(exchangesDir, `${encoded}.jsonl`);
  await fsp.mkdir(exchangesDir, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fsp.writeFile(filePath, content, 'utf8');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('normalizePromptKey', () => {
  test('lowercases, collapses whitespace, trims', () => {
    const { normalizePromptKey } = freshRequire(PAIRING_MOD);
    assert.equal(normalizePromptKey('  Hello   World  '), 'hello world');
    assert.equal(normalizePromptKey('Fix\nthe\t\tbug'), 'fix the bug');
  });

  test('truncates at 500 chars', () => {
    const { normalizePromptKey } = freshRequire(PAIRING_MOD);
    const long = 'a'.repeat(800);
    assert.equal(normalizePromptKey(long).length, 500);
  });

  test('handles empty / null / undefined gracefully', () => {
    const { normalizePromptKey } = freshRequire(PAIRING_MOD);
    assert.equal(normalizePromptKey(''), '');
    assert.equal(normalizePromptKey(null), '');
    assert.equal(normalizePromptKey(undefined), '');
  });
});

describe('loadExchangeIndex', () => {
  test('returns empty Map when exchanges file does not exist', async () => {
    const { loadExchangeIndex } = freshRequire(PAIRING_MOD);
    const exchangesDir = path.join(tmpDir, 'missing-dir');
    const idx = await loadExchangeIndex(exchangesDir, '/some/project');
    assert.ok(idx instanceof Map);
    assert.equal(idx.size, 0, 'should return empty Map on missing file');
  });

  test('indexes exchange records by normalized prompt key', async () => {
    const { loadExchangeIndex } = freshRequire(PAIRING_MOD);
    const exchangesDir = path.join(tmpDir, 'idx-test-exchanges');
    const cwd = '/home/user/testproject';

    await writeExchangeFile(exchangesDir, cwd, [
      { ts: '2026-06-25T01:00:00Z', sessionId: 's1', cwd, prompt: 'Fix the bug', result: 'I fixed it.', summary: 'Bug fixed.' },
      { ts: '2026-06-25T01:01:00Z', sessionId: 's1', cwd, prompt: 'Add a feature', result: 'Feature added.', summary: 'Feature added.' },
    ]);

    const idx = await loadExchangeIndex(exchangesDir, cwd);
    assert.equal(idx.size, 2);
    assert.ok(idx.has('fix the bug'), 'should have normalized key');
    assert.equal(idx.get('fix the bug').result, 'I fixed it.');
    assert.equal(idx.get('fix the bug').summary, 'Bug fixed.');
  });

  test('skips malformed NDJSON lines without throwing', async () => {
    const { loadExchangeIndex, normalizePromptKey } = freshRequire(PAIRING_MOD);
    const { encodeCwd } = require('../lib/encodeCwd.cjs');
    const exchangesDir = path.join(tmpDir, 'malformed-test');
    const cwd = '/home/user/malformed';

    await fsp.mkdir(exchangesDir, { recursive: true });
    const encoded = encodeCwd(cwd);
    const filePath = path.join(exchangesDir, `${encoded}.jsonl`);
    await fsp.writeFile(filePath, [
      'not-json-at-all',
      JSON.stringify({ ts: '2026-06-25T00:00:00Z', sessionId: 's1', cwd, prompt: 'valid prompt', result: 'ok', summary: 'ok' }),
      '{ broken json',
    ].join('\n') + '\n', 'utf8');

    const idx = await loadExchangeIndex(exchangesDir, cwd);
    assert.equal(idx.size, 1, 'should index only the valid line');
    assert.ok(idx.has(normalizePromptKey('valid prompt')));
  });
});

describe('enrichEntries', () => {
  test('adds result and summary when exchange matches by prompt text', async () => {
    const { loadExchangeIndex, enrichEntries } = freshRequire(PAIRING_MOD);
    const exchangesDir = path.join(tmpDir, 'enrich-match');
    const cwd = '/home/user/myapp';

    await writeExchangeFile(exchangesDir, cwd, [
      { ts: '2026-06-25T10:00:00Z', sessionId: 's1', cwd, prompt: 'Refactor the scheduler', result: 'I refactored it.', summary: 'Scheduler refactored.' },
    ]);

    const idx = await loadExchangeIndex(exchangesDir, cwd);

    const entries = [
      { ts: '2026-06-25T09:59:00Z', session_id: 's1', cwd, prompt: 'Refactor the scheduler' },
      { ts: '2026-06-25T09:58:00Z', session_id: 's1', cwd, prompt: 'Unrelated prompt' },
    ];

    const enriched = enrichEntries(entries, idx);

    // First entry has a match — should have result + summary
    assert.equal(enriched[0].result, 'I refactored it.', 'matched entry should get result');
    assert.equal(enriched[0].summary, 'Scheduler refactored.', 'matched entry should get summary');
    // Original fields preserved
    assert.equal(enriched[0].prompt, 'Refactor the scheduler');
    assert.equal(enriched[0].cwd, cwd);

    // Second entry has no match — returned unchanged (no result/summary)
    assert.equal(enriched[1].result, undefined, 'unmatched entry should not get result');
    assert.equal(enriched[1].summary, undefined, 'unmatched entry should not get summary');
    assert.equal(enriched[1].prompt, 'Unrelated prompt');
  });

  test('falls back to prompt-only when exchange index is empty (missing file)', async () => {
    const { loadExchangeIndex, enrichEntries } = freshRequire(PAIRING_MOD);
    // Point at a directory that doesn't exist
    const idx = await loadExchangeIndex(path.join(tmpDir, 'nonexistent'), '/some/cwd');
    assert.equal(idx.size, 0);

    const entries = [
      { ts: '2026-06-25T00:00:00Z', session_id: 'sx', cwd: '/some/cwd', prompt: 'Do something' },
    ];
    const enriched = enrichEntries(entries, idx);
    // Entry returned unchanged — no crash
    assert.equal(enriched.length, 1);
    assert.equal(enriched[0].prompt, 'Do something');
    assert.equal(enriched[0].result, undefined);
    assert.equal(enriched[0].summary, undefined);
  });

  test('whitespace-tolerant matching (trailing newline in one source)', async () => {
    const { loadExchangeIndex, enrichEntries } = freshRequire(PAIRING_MOD);
    const exchangesDir = path.join(tmpDir, 'ws-tolerant');
    const cwd = '/home/user/wstol';

    // Exchange record has trailing whitespace/newline in prompt
    await writeExchangeFile(exchangesDir, cwd, [
      { ts: '2026-06-25T00:00:00Z', sessionId: 's1', cwd, prompt: '  Build the widget  \n', result: 'Widget built.', summary: 'Widget.' },
    ]);

    const idx = await loadExchangeIndex(exchangesDir, cwd);

    // Prompt log entry has clean text — should still match after normalization
    const entries = [{ ts: '2026-06-25T00:00:01Z', session_id: 's1', cwd, prompt: 'Build the widget' }];
    const enriched = enrichEntries(entries, idx);
    assert.equal(enriched[0].result, 'Widget built.', 'should match despite whitespace differences');
  });
});
