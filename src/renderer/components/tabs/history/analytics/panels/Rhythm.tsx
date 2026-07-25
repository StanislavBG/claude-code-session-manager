import { useMemo } from 'react'
import type { FacetedDay } from '../../../../../lib/historyFacet'
import type { Measure } from '../../../../../lib/analyticsViewModel'
import { measureValue } from '../../../../../lib/analyticsViewModel'

interface Props {
  days: FacetedDay[]
  measure: Measure
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Rhythm({ days, measure }: Props) {
  const { buckets, weekendShare, peakIdx } = useMemo(() => {
    const buckets = new Array(7).fill(0)
    for (const day of days) {
      const [y, m, d] = day.date.split('-').map(Number)
      const dow = new Date(y, m - 1, d).getDay()
      buckets[dow] += measureValue(day.totals, measure)
    }
    const total = buckets.reduce((a, b) => a + b, 0)
    const weekend = buckets[0] + buckets[6]
    let peakIdx = 0
    for (let i = 1; i < 7; i++) if (buckets[i] > buckets[peakIdx]) peakIdx = i
    return { buckets, weekendShare: total > 0 ? (weekend / total) * 100 : 0, peakIdx }
  }, [days, measure])

  const max = Math.max(...buckets, 1)

  return (
    <div className="border border-line rounded bg-bg-elev p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-fg">Rhythm</h3>
        <span className="text-xs font-mono text-fg-faint">weekend {weekendShare.toFixed(0)}%</span>
      </div>
      <div className="flex items-end gap-2 h-24">
        {buckets.map((v, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1 h-full">
            <div
              className={`w-full rounded-t ${i === peakIdx ? 'bg-accent' : 'bg-hive-slate'}`}
              style={{ height: `${max > 0 ? (v / max) * 100 : 0}%`, minHeight: v > 0 ? 2 : 0 }}
            />
            <span className="text-[9px] text-fg-faint">{WEEKDAY_LABELS[i]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
