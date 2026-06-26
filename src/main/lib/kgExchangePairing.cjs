'use strict';

/**
 * kgExchangePairing.cjs — helpers for enriching KG prompt entries with their
 * corresponding exchange results (prompt+outcome pairs from exchanges.cjs).
 *
 * Pure functions + one async file loader. No electron dependency — directly
 * testable with node:test.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { encodeCwd } = require('./encodeCwd.cjs');

/**
 * Stable lookup key for a prompt: lowercased, whitespace-collapsed, first 500
 * chars. Both prompt-log entries and exchange records use this so matching is
 * tolerant of minor whitespace differences (e.g. trailing newline in one source).
 */
function normalizePromptKey(text) {
  return String(text || '').trim().slice(0, 500).toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build an in-memory index from an exchanges JSONL file for the given cwd.
 * Returns Map<normalizedPromptKey, exchangeRecord> (last-write wins for
 * duplicate prompts). Returns an empty Map when the file is absent or unreadable
 * so callers always fall back gracefully to prompt-only behavior.
 *
 * @param {string} exchangesDir  absolute path to the exchanges directory
 * @param {string} cwd           project working directory
 * @returns {Promise<Map<string, object>>}
 */
async function loadExchangeIndex(exchangesDir, cwd) {
  const filePath = path.join(exchangesDir, `${encodeCwd(cwd)}.jsonl`);
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const index = new Map();
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec && rec.prompt) {
          index.set(normalizePromptKey(rec.prompt), rec);
        }
      } catch { /* skip malformed lines */ }
    }
    return index;
  } catch {
    // File missing or unreadable — fall back to prompt-only; never block ingest.
    return new Map();
  }
}

/**
 * Enrich prompt-log entries with result/summary from the exchange index.
 * Returns a new array; entries without a match are returned unchanged.
 *
 * @param {Array<{ts: string, prompt: string, [key: string]: any}>} entries
 * @param {Map<string, object>} exchangeIndex  from loadExchangeIndex()
 * @returns {Array<object>}
 */
function enrichEntries(entries, exchangeIndex) {
  return entries.map((entry) => {
    const key = normalizePromptKey(entry.prompt);
    const exchange = exchangeIndex.get(key);
    if (exchange && (exchange.result || exchange.summary)) {
      return { ...entry, result: exchange.result, summary: exchange.summary };
    }
    return entry;
  });
}

module.exports = { normalizePromptKey, loadExchangeIndex, enrichEntries };
