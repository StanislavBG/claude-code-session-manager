import { describe, it, expect } from 'vitest'
import { computeDelta, computeBudgetProjection } from '../../src/renderer/lib/historyMath'

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
