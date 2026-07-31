import type { Measure } from '../../../../lib/analyticsViewModel'
import { MEASURE_LABELS } from '../../../../lib/analyticsViewModel'
import type { Headline as HeadlineData } from '../../../../lib/analyticsViewModel'
import { usd, tok, int, min, pct } from '../../../../lib/analyticsFormat'
import { CARD, SectionHead } from './analytics-primitives'

export function formatMeasureValue(measure: Measure, value: number): string {
  switch (measure) {
    case 'spend': return usd(value)
    case 'in': case 'out': case 'total': return tok(value)
    case 'time': return min(value)
    default: return int(value)
  }
}

interface Props {
  measure: Measure
  headline: HeadlineData
  activeDays: number
  projectsTouched: number
  totalSessions: number
}

export function Headline({ measure, headline, activeDays, projectsTouched, totalSessions }: Props) {
  const perActiveDay = activeDays > 0 ? headline.value / activeDays : 0
  const perSession = totalSessions > 0 ? headline.value / totalSessions : 0
  const { delta } = headline
  // Spend is inverted: a lower spend is the "good" direction.
  const isGood = delta && (measure === 'spend' ? delta.direction === 'down' : delta.direction === 'up')
  const isBad = delta && delta.direction !== 'flat' && (measure === 'spend' ? delta.direction === 'up' : delta.direction === 'down')
  const tone = isGood ? 'text-delta-good' : isBad ? 'text-delta-bad' : 'text-fg-faint'

  return (
    <div className={`${CARD} p-4`}>
      <SectionHead kicker="01 · overview" title={MEASURE_LABELS[measure]} />
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[52px] leading-none font-mono tracking-tight text-fg">{formatMeasureValue(measure, headline.value)}</div>
          {delta ? (
            <div className={`text-xs font-mono mt-2 ${tone}`}>
              {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '·'} {pct(Math.abs(delta.pct ?? 0))} vs prior period
            </div>
          ) : (
            <div className="text-xs text-fg-faint mt-2">no prior window to compare</div>
          )}
        </div>
        <div className="flex-1 min-w-0 self-stretch">
          <Sparkline series={headline.series} />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3 mt-4 pt-3 border-t border-line">
        <SubStat label="per active day" value={formatMeasureValue(measure, perActiveDay)} />
        <SubStat label="per session" value={formatMeasureValue(measure, perSession)} />
        <SubStat label="active days" value={int(activeDays)} />
        <SubStat label="projects touched" value={int(projectsTouched)} />
      </div>
    </div>
  )
}

function SubStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-fg-faint uppercase tracking-wider">{label}</div>
      <div className="text-[17px] font-mono tracking-tight text-fg-dim">{value}</div>
    </div>
  )
}

function Sparkline({ series }: { series: number[] }) {
  const width = 160
  const height = 48
  if (series.length < 2) return null
  const max = Math.max(...series, 0)
  const min_ = Math.min(...series, 0)
  const range = max - min_ || 1
  const step = width / (series.length - 1)
  const points = series.map((v, i) => `${i * step},${height - ((v - min_) / range) * height}`).join(' ')
  const areaPoints = `0,${height} ${points} ${width},${height}`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-full min-h-[48px]">
      <polygon points={areaPoints} fill="#b85c34" opacity={0.15} />
      <polyline points={points} fill="none" stroke="#b85c34" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
