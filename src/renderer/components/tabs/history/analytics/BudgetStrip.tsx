import { useEffect, useMemo, useState } from 'react'
import type { HistoryDashboardDay } from '../../../../../preload/api'
import { computeBudgetProjection } from '../../../../lib/historyMath'
import { usd } from '../../../../lib/analyticsFormat'

// Preserved verbatim from the pre-rewrite HistoryDashboard.tsx so a user's
// saved cap survives this rewrite.
const BUDGET_CAP_STORAGE_KEY = 'sm.history.budgetCapUsd'
const DEFAULT_BUDGET_CAP_USD = 50

interface Props {
  /** Unfaceted — budget is a global monthly figure, not scoped to the project facet. */
  days: HistoryDashboardDay[]
}

export function BudgetStrip({ days }: Props) {
  const [capUsd, setCapUsd] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(BUDGET_CAP_STORAGE_KEY)
      const parsed = raw === null ? NaN : Number(raw)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET_CAP_USD
    } catch {
      return DEFAULT_BUDGET_CAP_USD
    }
  })

  useEffect(() => {
    try { localStorage.setItem(BUDGET_CAP_STORAGE_KEY, String(capUsd)) } catch { /* quota / private mode — ignore */ }
  }, [capUsd])

  const { mtdSpend, projectedSpend } = useMemo(() => {
    const now = new Date()
    const monthPrefix = now.toLocaleDateString('en-CA').slice(0, 7)
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    const daysElapsed = now.getDate()
    let mtd = 0
    for (const day of days) {
      if (!day.date.startsWith(monthPrefix)) continue
      for (const row of Object.values(day.byProject)) mtd += row.estimatedCostUsd
    }
    return { mtdSpend: mtd, projectedSpend: computeBudgetProjection(mtd, daysElapsed, daysInMonth) }
  }, [days])

  const overBudget = projectedSpend > capUsd
  const pctOfCap = capUsd > 0 ? Math.min(100, (mtdSpend / capUsd) * 100) : 0

  return (
    <div className="border border-line rounded bg-bg-elev p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-wider text-fg-faint">Monthly budget</h3>
        <label className="flex items-center gap-1.5 text-[10px] text-fg-faint">
          cap
          <span>$</span>
          <input
            type="number"
            min={1}
            step={1}
            value={capUsd}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v > 0) setCapUsd(v)
            }}
            className="w-16 bg-bg border border-line rounded px-1.5 py-0.5 text-xs text-fg font-mono"
          />
        </label>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono mb-1.5">
        <span className="text-fg">{usd(mtdSpend)} <span className="text-fg-faint">month-to-date</span></span>
        <span className={overBudget ? 'text-red-400' : 'text-fg-dim'}>
          {usd(projectedSpend)} <span className="text-fg-faint">projected</span>
        </span>
      </div>
      <div className="h-1.5 rounded bg-bg-hi overflow-hidden">
        <div
          className={`h-full ${overBudget ? 'bg-red-400' : 'bg-sage'}`}
          style={{ width: `${Math.max(pctOfCap, pctOfCap > 0 ? 2 : 0)}%` }}
        />
      </div>
      <div className={`text-[10px] mt-1 font-mono ${overBudget ? 'text-red-400' : 'text-fg-faint'}`}>
        {overBudget ? `projected to exceed $${capUsd.toFixed(0)} cap` : `${pctOfCap.toFixed(0)}% of $${capUsd.toFixed(0)} cap`}
      </div>
    </div>
  )
}
