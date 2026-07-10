import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)

const { remote, MODEL_PRICING, scanAggrLines, parseJSONL, resolvePricingKey } =
  require('../../src/main/historyAggregator.cjs')

describe('MODEL_PRICING', () => {
  it('has opus/sonnet/haiku buckets with input/output/cache-read rates', () => {
    for (const key of ['opus', 'sonnet', 'haiku']) {
      expect(MODEL_PRICING[key]).toBeTruthy()
      expect(typeof MODEL_PRICING[key].i).toBe('number')
      expect(typeof MODEL_PRICING[key].o).toBe('number')
      expect(typeof MODEL_PRICING[key].c).toBe('number')
    }
  })

  it('prices cache-read tokens far below input tokens (the cache-savings premise)', () => {
    for (const key of ['opus', 'sonnet', 'haiku']) {
      expect(MODEL_PRICING[key].c).toBeLessThan(MODEL_PRICING[key].i)
    }
  })
})

describe('resolvePricingKey', () => {
  it('matches opus/sonnet/haiku by case-insensitive substring', () => {
    expect(resolvePricingKey('claude-opus-4-8-20260115')).toEqual({ key: 'opus', estimated: false })
    expect(resolvePricingKey('claude-sonnet-5')).toEqual({ key: 'sonnet', estimated: false })
    expect(resolvePricingKey('claude-HAIKU-4-5-20251001')).toEqual({ key: 'haiku', estimated: false })
  })

  it('falls back to sonnet, flagged as estimated, for unrecognized ids', () => {
    expect(resolvePricingKey('some-future-model-x')).toEqual({ key: 'sonnet', estimated: true })
    expect(resolvePricingKey(undefined)).toEqual({ key: 'sonnet', estimated: true })
  })
})

describe('scanAggrLines byModel bucketing', () => {
  it('accumulates per-model token buckets alongside the flat totals', () => {
    const acc: any = {
      promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      toolCallCount: 0, toolBreakdown: {}, byModel: {} as Record<string, any>, errorCount: 0,
    }
    const lines = [
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', usage: {
        input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5,
      } } }),
      JSON.stringify({ message: { role: 'assistant', model: 'claude-opus-4-8-20260115', usage: {
        input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      } } }),
      // a second sonnet line to verify same-model buckets sum, not overwrite
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', usage: {
        input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1,
      } } }),
      // no model on this line — must not touch byModel or throw
      JSON.stringify({ type: 'tool_result', is_error: false }),
    ]
    scanAggrLines(lines, acc, false)

    expect(acc.inputTokens).toBe(121)
    expect(acc.outputTokens).toBe(61)
    expect(acc.byModel['claude-sonnet-5']).toEqual({
      inputTokens: 101, outputTokens: 51, cacheReadTokens: 11, cacheCreationTokens: 6,
    })
    expect(acc.byModel['claude-opus-4-8-20260115']).toEqual({
      inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0,
    })
  })
})

describe('parseJSONL tail-merge preserves byModel across appends', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true })
  })

  it('merges per-model buckets by key-sum on an append-only tail parse', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-hist-test-'))
    const file = path.join(dir, 'session.jsonl')
    const sonnetLine = JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-5', usage: {
      input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0,
    } } })
    await fsp.writeFile(file, sonnetLine + '\n')
    let stat = await fsp.stat(file)
    const first = await parseJSONL(file, stat)
    expect(first.result.byModel['claude-sonnet-5'].inputTokens).toBe(100)

    // Append a second line for the SAME model — must sum, not replace.
    await fsp.appendFile(file, sonnetLine + '\n')
    stat = await fsp.stat(file)
    const second = await parseJSONL(file, stat)
    expect(second.cacheHit).toBe(false)
    expect(second.result.byModel['claude-sonnet-5'].inputTokens).toBe(200)
    expect(second.result.byModel['claude-sonnet-5'].outputTokens).toBe(100)

    // Exact same stat again → cache hit, same result.
    const third = await parseJSONL(file, stat)
    expect(third.cacheHit).toBe(true)
    expect(third.result.byModel['claude-sonnet-5'].inputTokens).toBe(200)
  })
})

describe('remote.aggregate', () => {
  it('returns the existing result shape plus per-model costUsd and a top-level cacheSavingsUsd', async () => {
    const result = await remote.aggregate({})
    expect(Array.isArray(result.rows)).toBe(true)
    expect(typeof result.scannedMs).toBe('number')
    expect(typeof result.cacheSavingsUsd).toBe('number')
    for (const row of result.rows) {
      expect(row.byModel).toBeTypeOf('object')
      for (const bucket of Object.values(row.byModel) as any[]) {
        expect(typeof bucket.costUsd).toBe('number')
      }
    }
  })
})
