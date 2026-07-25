import type { HistoryDashboardTotals } from '../../../../../../preload/api'
import { tok } from '../../../../../lib/analyticsFormat'

interface Props {
  totals: HistoryDashboardTotals
}

export function CachePanel({ totals }: Props) {
  const denom = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  const hitPct = denom > 0 ? (totals.cacheReadTokens / denom) * 100 : 0
  const circumference = 2 * Math.PI * 26

  return (
    <div className="border border-line rounded bg-bg-elev p-4">
      <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Cache</h3>
      <div className="flex items-center gap-4">
        <div className="relative shrink-0" style={{ width: 64, height: 64 }}>
          <svg width={64} height={64} viewBox="0 0 64 64" className="-rotate-90">
            <circle cx={32} cy={32} r={26} fill="none" stroke="currentColor" className="text-bg-hi" strokeWidth={6} />
            <circle
              cx={32} cy={32} r={26} fill="none" stroke="#6f7d52" strokeWidth={6}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - hitPct / 100)}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-fg">
            {hitPct.toFixed(0)}%
          </div>
        </div>
        <div className="text-[11px] space-y-1 font-mono">
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg-faint">reused (cache read)</span>
            <span className="text-fg-dim">{tok(totals.cacheReadTokens)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-fg-faint">written to cache</span>
            <span className="text-fg-dim">{tok(totals.cacheCreationTokens)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
