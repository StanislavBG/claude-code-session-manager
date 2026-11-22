'use strict';

/**
 * modelPricing.cjs — the current price of each Claude model id, and the dollar cost of one
 * usage bucket. Pure: no I/O, no imports, never throws.
 *
 * Source: the `claude-api` skill's model and prompt-caching reference, cached 2026-11-03,
 * read on 2026-11-21. Prices are dollars per million tokens.
 *
 * Cache writes cost CACHE_WRITE_5M_MULTIPLIER × input for the 5-minute cache and
 * CACHE_WRITE_1H_MULTIPLIER × input for the 1-hour cache, on every model. When a bucket does not
 * say how its cache writes split, all of them are charged at the 1-hour rate and the result is
 * marked estimated: on 2026-11-21 this machine's last 48 hours of transcripts had 93.5% of
 * cache-write tokens as 1-hour writes.
 *
 * Known limits, deliberately NOT modeled (on 2026-11-21 the last 48 hours of transcripts had no
 * such call):
 *   1. Claude Haiku 5.5 prompts over 100K tokens cost 0.50 / 2.50 (input / output), not the base rate.
 *   2. Fast mode costs more than the rates below.
 */

/** @typedef {{ input: number, output: number, cacheRead: number }} ModelPrice */

const row = (input, output, cacheRead) => Object.freeze({ input, output, cacheRead });

// cacheRead is stated outright by the reference for Fable 5.2, Fable 5.1, Fable 5, Opus 5.5 and
// Sonnet 5.5 (and their Mythos twins). Every other row's cacheRead is derived from the general
// rule, 0.1 × input: opus-5, opus-4-8, opus-4-7, opus-4-6, sonnet-5, sonnet-4-6, haiku-5-5, haiku-4-5.
const MODEL_PRICES = Object.freeze({
  'claude-fable-5-2': row(8, 40, 0.20),
  'claude-mythos-5-2': row(8, 40, 0.20),
  'claude-fable-5-1': row(10, 50, 0.25),
  'claude-mythos-5-1': row(10, 50, 0.25),
  'claude-fable-5': row(10, 50, 1.00),
  'claude-mythos-5': row(10, 50, 1.00),
  'claude-opus-5-5': row(4, 20, 0.20),
  'claude-opus-5': row(5, 25, 0.50),
  'claude-opus-4-8': row(5, 25, 0.50),
  'claude-opus-4-7': row(5, 25, 0.50),
  'claude-opus-4-6': row(5, 25, 0.50),
  'claude-sonnet-5-5': row(2, 10, 0.10),
  'claude-sonnet-5': row(2, 10, 0.20),
  'claude-sonnet-4-6': row(3, 15, 0.30),
  'claude-haiku-5-5': row(0.10, 0.50, 0.01),
  'claude-haiku-4-5': row(1, 5, 0.10),
});

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

// Newest row per family, used to price an id that matches no row. Order matters only in that the
// first family word found wins.
const FAMILY_FALLBACK = Object.freeze([
  ['fable', 'claude-fable-5-2'],
  ['mythos', 'claude-mythos-5-2'],
  ['opus', 'claude-opus-5-5'],
  ['sonnet', 'claude-sonnet-5-5'],
  ['haiku', 'claude-haiku-5-5'],
]);
const DEFAULT_ID = 'claude-sonnet-5-5';

// Bedrock-style provider prefixes: `anthropic.`, `us.anthropic.`, `global.anthropic.`, …
const PROVIDER_PREFIX_RE = /^(?:[a-z0-9-]+\.)*anthropic\./;
// What may follow a row id: a -YYYYMMDD date, a `[1m]`-style context tag, or a Vertex `@` version.
const ROW_CONTINUATION_RE = /^(?:-\d{8}(?!\d)|\[|@)/;

/**
 * @param {string} rowId
 * @param {boolean} estimated
 */
function priced(rowId, estimated) {
  const p = MODEL_PRICES[/** @type {keyof typeof MODEL_PRICES} */ (rowId)];
  return { id: rowId, input: p.input, output: p.output, cacheRead: p.cacheRead, estimated };
}

/**
 * @param {unknown} modelId
 * @returns {{ id: string, input: number, output: number, cacheRead: number, estimated: boolean }}
 */
function priceForModel(modelId) {
  const id = typeof modelId === 'string' ? modelId.toLowerCase().replace(PROVIDER_PREFIX_RE, '') : '';
  if (id) {
    for (const rowId of Object.keys(MODEL_PRICES)) {
      if (id === rowId) return priced(rowId, false);
      if (id.startsWith(rowId) && ROW_CONTINUATION_RE.test(id.slice(rowId.length))) return priced(rowId, false);
    }
    for (const [family, rowId] of FAMILY_FALLBACK) {
      if (id.includes(family)) return priced(rowId, true);
    }
  }
  return priced(DEFAULT_ID, true);
}

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * @param {unknown} modelId
 * @param {unknown} bucket  { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens? }
 * @returns {{ costUsd: number, cacheSavingsUsd: number, estimated: boolean }}
 */
function costOfUsage(modelId, bucket) {
  const price = priceForModel(modelId);
  /** @type {Record<string, unknown>} */
  const b = bucket && typeof bucket === 'object' ? /** @type {Record<string, unknown>} */ (bucket) : {};
  const input = num(b.inputTokens);
  const output = num(b.outputTokens);
  const cacheRead = num(b.cacheReadTokens);
  const cacheWrite = Math.max(0, num(b.cacheCreationTokens));
  let estimated = price.estimated;
  let write1h;
  if (typeof b.cacheCreation1hTokens === 'number' && Number.isFinite(b.cacheCreation1hTokens)) {
    write1h = Math.min(Math.max(0, b.cacheCreation1hTokens), cacheWrite);
  } else {
    write1h = cacheWrite;
    if (cacheWrite > 0) estimated = true;
  }
  const write5m = cacheWrite - write1h;
  const costUsd = (
    input * price.input +
    output * price.output +
    cacheRead * price.cacheRead +
    write5m * price.input * CACHE_WRITE_5M_MULTIPLIER +
    write1h * price.input * CACHE_WRITE_1H_MULTIPLIER
  ) / 1e6;
  const cacheSavingsUsd = cacheRead * (price.input - price.cacheRead) / 1e6;
  return { costUsd, cacheSavingsUsd, estimated };
}

module.exports = {
  MODEL_PRICES,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  priceForModel,
  costOfUsage,
};
