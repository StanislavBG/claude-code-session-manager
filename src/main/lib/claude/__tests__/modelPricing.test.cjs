/**
 * modelPricing.test.cjs — per-model-id price table and usage-bucket cost.
 *
 * Run: timeout 180 npx vitest run src/main/lib/claude/__tests__/modelPricing.test.cjs
 */
import { describe, it, expect } from 'vitest';
const {
  MODEL_PRICES,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  priceForModel,
  costOfUsage,
} = require('../modelPricing.cjs');

const close = (a, b) => expect(a).toBeCloseTo(b, 9);

describe('MODEL_PRICES', () => {
  it('holds exactly the listed rows, frozen', () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual([
      'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2',
      'claude-haiku-4-5', 'claude-haiku-5-5',
      'claude-mythos-5', 'claude-mythos-5-1', 'claude-mythos-5-2',
      'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
      'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5',
    ].sort());
    expect(Object.isFrozen(MODEL_PRICES)).toBe(true);
    expect(Object.isFrozen(MODEL_PRICES['claude-opus-5-5'])).toBe(true);
    expect(MODEL_PRICES['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(MODEL_PRICES['claude-fable-5-2']).toEqual({ input: 8, output: 40, cacheRead: 0.2 });
    expect(MODEL_PRICES['claude-fable-5']).toEqual({ input: 10, output: 50, cacheRead: 1 });
    expect(MODEL_PRICES['claude-haiku-5-5']).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01 });
    expect(MODEL_PRICES['claude-sonnet-4-6']).toEqual({ input: 3, output: 15, cacheRead: 0.3 });
  });
  it('exports the cache-write multipliers', () => {
    expect(CACHE_WRITE_5M_MULTIPLIER).toBe(1.25);
    expect(CACHE_WRITE_1H_MULTIPLIER).toBe(2);
  });
});

describe('priceForModel', () => {
  it('matches an exact id and does not confuse opus-5-5 with opus-5', () => {
    expect(priceForModel('claude-opus-5-5')).toEqual({ id: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, estimated: false });
    expect(priceForModel('claude-opus-5')).toEqual({ id: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5, estimated: false });
  });
  it('matches a dated id, a [1m] id and an @ id', () => {
    expect(priceForModel('claude-opus-4-8-20260115')).toMatchObject({ id: 'claude-opus-4-8', estimated: false });
    expect(priceForModel('claude-opus-5-5[1m]')).toMatchObject({ id: 'claude-opus-5-5', estimated: false });
    expect(priceForModel('claude-sonnet-5@20261001')).toMatchObject({ id: 'claude-sonnet-5', estimated: false });
  });
  it('lower-cases and strips a provider prefix ending in anthropic.', () => {
    expect(priceForModel('CLAUDE-OPUS-5-5')).toMatchObject({ id: 'claude-opus-5-5', estimated: false });
    expect(priceForModel('us.anthropic.claude-haiku-4-5-20251001')).toMatchObject({ id: 'claude-haiku-4-5', estimated: false });
    expect(priceForModel('anthropic.claude-sonnet-4-6')).toMatchObject({ id: 'claude-sonnet-4-6', estimated: false });
  });
  it('does not match a wrong-length date suffix or other continuations', () => {
    expect(priceForModel('claude-opus-5-2026')).toMatchObject({ id: 'claude-opus-5-5', estimated: true });
    expect(priceForModel('claude-opus-5-55')).toMatchObject({ id: 'claude-opus-5-5', estimated: true });
  });
  it('prices an unknown id as the newest row of its family, estimated', () => {
    expect(priceForModel('claude-fable-9')).toMatchObject({ id: 'claude-fable-5-2', estimated: true });
    expect(priceForModel('claude-mythos-9')).toMatchObject({ id: 'claude-mythos-5-2', estimated: true });
    expect(priceForModel('claude-opus-3')).toMatchObject({ id: 'claude-opus-5-5', estimated: true });
    expect(priceForModel('claude-sonnet-3-7')).toMatchObject({ id: 'claude-sonnet-5-5', estimated: true });
    expect(priceForModel('claude-haiku-3')).toMatchObject({ id: 'claude-haiku-5-5', estimated: true });
  });
  it('prices a familyless or missing id as sonnet-5-5, estimated', () => {
    for (const id of ['gpt-x', '<synthetic>', '', undefined, null, 42]) {
      expect(priceForModel(id)).toEqual({ id: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.1, estimated: true });
    }
  });
});

describe('costOfUsage', () => {
  it('charges each token kind at its rate with a known 1h split', () => {
    const r = costOfUsage('claude-opus-5-5', {
      inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6,
      cacheCreationTokens: 3e6, cacheCreation1hTokens: 1e6,
    });
    // 4 + 20 + 0.2 + 2e6*4*1.25/1e6 (10) + 1e6*4*2/1e6 (8)
    close(r.costUsd, 42.2);
    close(r.cacheSavingsUsd, 3.8);
    expect(r.estimated).toBe(false);
  });
  it('caps the 1h part at cacheCreationTokens', () => {
    const r = costOfUsage('claude-opus-5-5', { cacheCreationTokens: 1e6, cacheCreation1hTokens: 5e6 });
    close(r.costUsd, 8);
    expect(r.estimated).toBe(false);
  });
  it('charges all writes at 5m when the 1h part is zero', () => {
    const r = costOfUsage('claude-opus-5-5', { cacheCreationTokens: 1e6, cacheCreation1hTokens: 0 });
    close(r.costUsd, 5);
    expect(r.estimated).toBe(false);
  });
  it('charges all writes at 1h and marks estimated when the split is unknown', () => {
    const r = costOfUsage('claude-opus-5-5', { cacheCreationTokens: 1e6 });
    close(r.costUsd, 8);
    expect(r.estimated).toBe(true);
  });
  it('does not mark estimated for an unknown split with no cache writes', () => {
    const r = costOfUsage('claude-opus-5-5', { inputTokens: 1e6 });
    close(r.costUsd, 4);
    expect(r.estimated).toBe(false);
  });
  it('carries the estimated flag of an unknown model', () => {
    const r = costOfUsage('mystery', { inputTokens: 1e6, cacheCreationTokens: 0 });
    close(r.costUsd, 2);
    expect(r.estimated).toBe(true);
  });
  it('treats missing or non-numeric fields as zero and never throws', () => {
    for (const bucket of [undefined, null, {}, 'x', { inputTokens: 'lots', outputTokens: NaN, cacheReadTokens: null }]) {
      const r = costOfUsage('claude-opus-5-5', bucket);
      expect(r.costUsd).toBe(0);
      expect(r.cacheSavingsUsd).toBe(0);
    }
    expect(() => costOfUsage(undefined, undefined)).not.toThrow();
  });
});
