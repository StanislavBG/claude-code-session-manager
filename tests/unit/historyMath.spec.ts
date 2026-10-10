import { describe, it, expect } from 'vitest'
import { computeDelta, computeBudgetProjection, sumDayTotals } from '../../src/renderer/lib/historyMath'

describe('computeDelta', () => {
  it('returns null pct and flat direction when previous total is zero', () => {
    expect(computeDelta(50, 0)).toEqual({ pct: null, direction: 'flat' })
  })

  it('computes a positive delta as up', () => {
    const d = computeDelta(150, 100)
    expect(d.pct).toBeCloseTo(50)
    expect(d.direction).toBe('up')
  })

  it('computes a negative delta as down', () => {
    const d = computeDelta(80, 100)
    expect(d.pct).toBeCloseTo(-20)
    expect(d.direction).toBe('down')
  })

  it('computes zero change as flat', () => {
    const d = computeDelta(100, 100)
    expect(d.pct).toBe(0)
    expect(d.direction).toBe('flat')
  })
})

describe('computeBudgetProjection', () => {
  it('extrapolates spend-per-day across the full month', () => {
    expect(computeBudgetProjection(30, 10, 30)).toBeCloseTo(90)
  })

  it('handles a partial month with fewer elapsed days', () => {
    expect(computeBudgetProjection(15, 3, 31)).toBeCloseTo(155)
  })

  it('returns 0 when no days have elapsed yet', () => {
    expect(computeBudgetProjection(0, 0, 30)).toBe(0)
  })
})

describe('sumDayTotals', () => {
  const mb = (n: number) => ({ inputTokens: n, outputTokens: n * 2, cacheReadTokens: n * 3, cacheCreationTokens: n * 4, costUsd: n * 0.5 })
  const row = (n: number, byModel: Record<string, ReturnType<typeof mb>>) => ({
    promptCount: n, inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheCreationTokens: n,
    toolCallCount: n, sessionCount: n, errorCount: n, activeMinutes: n, estimatedCostUsd: n, byModel,
  })

  it('sums all ten fields and merges overlapping and disjoint models', () => {
    const r = sumDayTotals([row(1, { a: mb(1), b: mb(2) }), row(2, { a: mb(3), c: mb(4) })])
    expect(r.promptCount).toBe(3)
    expect(r.errorCount).toBe(3)
    expect(r.activeMinutes).toBe(3)
    expect(r.estimatedCostUsd).toBe(3)
    expect(r.byModel.a).toEqual(mb(4))
    expect(r.byModel.b).toEqual(mb(2))
    expect(r.byModel.c).toEqual(mb(4))
  })

  it('treats missing fields as 0, never NaN', () => {
    const r = sumDayTotals([{ inputTokens: 5, byModel: { a: { inputTokens: 1 } } }, {}])
    expect(r.inputTokens).toBe(5)
    expect(r.outputTokens).toBe(0)
    expect(r.byModel.a).toEqual({ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 })
    expect(Object.values(r).every((v) => typeof v !== 'number' || !Number.isNaN(v))).toBe(true)
  })

  it('returns zeros and empty byModel for empty input', () => {
    const r = sumDayTotals([])
    expect(r.byModel).toEqual({})
    expect(r.promptCount + r.estimatedCostUsd + r.toolCallCount).toBe(0)
  })
})
