// Single place that fetches History dashboard totals and turns them into display
// figures. Pure apart from the one IPC call: no React, no store.
import type { HistoryDashboardResult } from '../../preload/api'
import { tok, usd } from './analyticsFormat'
import { withTimeout } from './withTimeout'

export type HistoryTotalsResult =
  | { ok: true; data: HistoryDashboardResult }
  | { ok: false; error: string }

export interface SpendSummary {
  costUsd: number
  tokens: number
  label: string
}

export async function fetchHistoryTotals(
  rangeDays: 0 | 30 | 60 | 90,
  timeoutMs = 5000,
): Promise<HistoryTotalsResult> {
  try {
    // Promise.resolve().then: a synchronous throw (api not ready) is caught too.
    const data = await withTimeout(
      Promise.resolve().then(() => window.api.history.dashboard({ rangeDays })),
      timeoutMs,
      'history.dashboard',
    )
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

interface SpendFields {
  estimatedCostUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export function formatSpend(s: Pick<SpendSummary, 'costUsd' | 'tokens'>): string {
  return `${usd(s.costUsd)} · ${tok(s.tokens)} tok`
}

/** `opts.day` is a local YYYY-MM-DD; when given, only that day's per-day rows are summed. */
export function summarizeSpend(data: HistoryDashboardResult, opts?: { day?: string }): SpendSummary {
  const rows: SpendFields[] = opts?.day
    ? data.days.filter((d) => d.date === opts.day).flatMap((d) => Object.values(d.byProject))
    : [data.totals]
  let costUsd = 0
  let tokens = 0
  for (const r of rows) {
    costUsd += r.estimatedCostUsd
    tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens
  }
  return { costUsd, tokens, label: formatSpend({ costUsd, tokens }) }
}
