import { describe, it, expect } from 'vitest'
import { computeStackedBands } from '../stackedBands'

const days = [
  { date: '2026-07-01', values: { a: 10, b: 30 } },
  { date: '2026-07-02', values: { a: 0, b: 0 } },
  { date: '2026-07-03', values: { a: 40, b: 5 } },
]

describe('computeStackedBands', () => {
  it('orders bands by total descending, biggest at bottom (y0 = 0)', () => {
    const [day1] = computeStackedBands(days, 'absolute')
    // b has the bigger overall total (30+0+5=35 vs a's 10+0+40=50) -- recompute:
    // a total = 50, b total = 35 -> a is biggest -> a sits at the bottom.
    expect(day1.bands[0].projectDir).toBe('a')
    expect(day1.bands[0].y0).toBe(0)
    expect(day1.bands[0].y1).toBe(10)
    expect(day1.bands[1].projectDir).toBe('b')
    expect(day1.bands[1].y0).toBe(10)
    expect(day1.bands[1].y1).toBe(40)
  })

  it('absolute mode uses raw values as band heights', () => {
    const result = computeStackedBands(days, 'absolute')
    expect(result[2].total).toBe(45)
    expect(result[2].bands.find((b) => b.projectDir === 'a')!.y1).toBe(40)
  })

  it('share mode normalizes each day to 0..1', () => {
    const result = computeStackedBands(days, 'share')
    const day1 = result[0]
    expect(day1.bands[0].y1).toBeCloseTo(10 / 40, 5)
    expect(day1.bands[1].y1).toBeCloseTo(1, 5)
  })

  it('zero-total days produce zeroed bands with no NaN', () => {
    const result = computeStackedBands(days, 'share')
    const day2 = result[1]
    expect(day2.total).toBe(0)
    for (const b of day2.bands) {
      expect(b.y0).toBe(0)
      expect(b.y1).toBe(0)
      expect(Number.isNaN(b.y1)).toBe(false)
    }
  })
})
