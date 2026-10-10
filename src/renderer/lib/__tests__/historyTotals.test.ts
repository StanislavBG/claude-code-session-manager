import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryDashboardResult, HistoryDashboardTotals } from '../../../preload/api'
import { fetchHistoryTotals, formatSpend, summarizeSpend } from '../historyTotals'

const row = (cost: number, i: number, o: number, cr: number, cc: number) =>
  ({ estimatedCostUsd: cost, inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc }) as HistoryDashboardTotals

function payload(today: string): HistoryDashboardResult {
  return {
    totals: row(10, 1000, 2000, 3000, 4000),
    days: [
      { date: '2000-01-01', byProject: { a: { ...row(7, 700, 0, 0, 0), date: '2000-01-01', projectDir: 'a' } } },
      { date: today, byProject: {
        a: { ...row(1.5, 10, 20, 30, 40), date: today, projectDir: 'a' },
        b: { ...row(0.5, 1, 2, 3, 4), date: today, projectDir: 'b' },
      } },
    ],
  } as unknown as HistoryDashboardResult
}

function stubApi(dashboard: (...a: unknown[]) => unknown) {
  vi.stubGlobal('window', { api: { history: { dashboard } } })
}

describe('historyTotals', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('resolves ok with data and passes rangeDays', async () => {
    const dash = vi.fn().mockResolvedValue(payload('2026-10-09'))
    stubApi(dash)
    const r = await fetchHistoryTotals(30)
    expect(r.ok).toBe(true)
    expect(dash).toHaveBeenCalledWith({ rangeDays: 30 })
  })

  it('maps a rejection to ok:false', async () => {
    stubApi(() => Promise.reject(new Error('boom')))
    const r = await fetchHistoryTotals(30)
    expect(r).toEqual({ ok: false, error: 'boom' })
  })

  it('maps a synchronous throw to ok:false', async () => {
    stubApi(() => { throw new Error('not ready') })
    const r = await fetchHistoryTotals(0)
    expect(r.ok).toBe(false)
  })

  it('gives ok:false after the timeout when IPC never resolves', async () => {
    stubApi(() => new Promise(() => {}))
    const p = fetchHistoryTotals(30, 5000)
    await vi.advanceTimersByTimeAsync(5001)
    const r = await p
    expect(r.ok).toBe(false)
  })

  it('summarizes all totals, tokens summing the four fields', () => {
    const s = summarizeSpend(payload('2026-10-09'))
    expect(s.costUsd).toBe(10)
    expect(s.tokens).toBe(10000)
  })

  it('sums only the given day when opts.day is set', () => {
    const s = summarizeSpend(payload('2026-10-09'), { day: '2026-10-09' })
    expect(s.costUsd).toBe(2)
    expect(s.tokens).toBe(110)
  })

  it('returns zero for a day with no rows', () => {
    const s = summarizeSpend(payload('2026-10-09'), { day: '1999-12-31' })
    expect(s).toMatchObject({ costUsd: 0, tokens: 0 })
  })

  it('formats as "$x · y tok"', () => {
    const s = summarizeSpend(payload('2026-10-09'))
    expect(formatSpend(s)).toBe('$10.00 · 10.0K tok')
    expect(s.label).toBe(formatSpend(s))
  })
})
