import type { HistoryDashboardTotals } from '../../../../../../preload/api'
import { tok } from '../../../../../lib/analyticsFormat'
import { CARD, SAGE_HEX, SectionHead } from '../analytics-primitives'

interface Props {
  totals: HistoryDashboardTotals
}

const R = 30
const STROKE = 9
const SIZE = (R + STROKE) * 2

export function CachePanel({ totals }: Props) {
  const denom = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  const hitPct = denom > 0 ? (totals.cacheReadTokens / denom) * 100 : 0
  const circumference = 2 * Math.PI * R
  const c = SIZE / 2

  return (
    <div className={`${CARD} p-4`}>
      <SectionHead kicker="05 · composition" title="Cache" />
      <div className="flex items-center gap-4">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90">
            <circle cx={c} cy={c} r={R} fill="none" stroke="currentColor" className="text-bg-hi" strokeWidth={STROKE} />
            <circle
              cx={c} cy={c} r={R} fill="none" stroke={SAGE_HEX} strokeWidth={STROKE}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - hitPct / 100)}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-[13px] font-mono text-fg">
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
