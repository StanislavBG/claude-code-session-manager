import { describe, it, expect } from 'vitest'
import { buildUsageCsv, type CsvDayInput } from '../usageCsv'

function day(over: Partial<CsvDayInput> = {}): CsvDayInput {
  return {
    date: '2026-07-01',
    costUsd: 1.5,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 40,
    byModel: {
      'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 10 },
    },
    ...over,
  }
}

describe('buildUsageCsv', () => {
  it('emits the exact ten columns with one row per day', () => {
    const csv = buildUsageCsv([day()])
    const lines = csv.split('\n')
    expect(lines[0]).toBe(
      'date,cost_usd,input_tokens,output_tokens,cache_write_tokens,cache_read_tokens,total_tokens,cache_hit_pct,num_models,top_model'
    )
    expect(lines).toHaveLength(2)
  })

  it('computes total_tokens, cache_hit_pct, num_models, top_model', () => {
    const csv = buildUsageCsv([day()])
    const [, row] = csv.split('\n')
    const cols = row.split(',')
    expect(cols[0]).toBe('2026-07-01')
    expect(cols[1]).toBe('1.5000')
    expect(cols[6]).toBe('200') // 100 + 50 + 10 + 40
    // cache_hit_pct = cache_read / (input + cache_read + cache_write) = 40 / (100+40+10) = 26.7%
    expect(cols[7]).toBe('26.7')
    expect(cols[8]).toBe('1')
    expect(cols[9]).toBe('Sonnet 4.6')
  })

  it('handles an empty day (no models, zero tokens)', () => {
    const csv = buildUsageCsv([day({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, byModel: {} })])
    const [, row] = csv.split('\n')
    const cols = row.split(',')
    expect(cols[6]).toBe('0')
    expect(cols[7]).toBe('0.0')
    expect(cols[8]).toBe('0')
    expect(cols[9]).toBe('')
  })

  it('escapes fields containing commas or quotes', () => {
    const csv = buildUsageCsv([day({ byModel: { 'weird,"model"': { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } })])
    const [, row] = csv.split('\n')
    expect(row).toContain('"weird,""model"""')
  })
})
