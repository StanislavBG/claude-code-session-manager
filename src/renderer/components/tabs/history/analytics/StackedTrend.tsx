import { useMemo, useState } from 'react'
import { computeStackedBands, type StackedDayInput, type StackedMode } from '../../../../lib/stackedBands'
import { projectColorFor } from '../../../../lib/projectColor'
import { projectNameFromCwd } from '../../scheduler/sched-primitives'
import { tok, usd } from '../../../../lib/analyticsFormat'
import type { Measure } from '../../../../lib/analyticsViewModel'

interface Props {
  days: StackedDayInput[]
  measure: Measure
  selected: string | null
  onSelect: (projectDir: string | null) => void
}

const WIDTH = 720
const HEIGHT = 220
const PAD_LEFT = 44
const PAD_BOTTOM = 20

function formatAxisValue(measure: Measure, v: number): string {
  return measure === 'spend' ? usd(v) : tok(v)
}

export function StackedTrend({ days, measure, selected, onSelect }: Props) {
  const [mode, setMode] = useState<StackedMode>('absolute')
  const bands = useMemo(() => computeStackedBands(days, mode), [days, mode])

  const maxY = useMemo(() => {
    if (mode === 'share') return 1
    let max = 0
    for (const d of bands) max = Math.max(max, d.total)
    return max || 1
  }, [bands, mode])

  const plotW = WIDTH - PAD_LEFT
  const plotH = HEIGHT - PAD_BOTTOM
  const stepX = bands.length > 1 ? plotW / (bands.length - 1) : plotW
  const xFor = (i: number) => PAD_LEFT + i * stepX
  const yFor = (v: number) => plotH - (v / maxY) * plotH

  // Thin x labels to ~8 evenly spaced ticks.
  const labelEvery = Math.max(1, Math.ceil(bands.length / 8))

  const gridlineCount = 4
  const gridlines = Array.from({ length: gridlineCount + 1 }, (_, i) => (maxY / gridlineCount) * i)

  return (
    <div className="border border-line rounded bg-bg-elev p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs uppercase tracking-wider text-fg">Trend by project</h3>
        <div className="flex border border-line rounded overflow-hidden text-[10px]">
          {(['absolute', 'share'] as StackedMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 ${mode === m ? 'bg-accent text-white' : 'text-fg-faint hover:text-fg'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="overflow-visible">
        {gridlines.map((gv, i) => (
          <g key={i}>
            <line x1={PAD_LEFT} x2={WIDTH} y1={yFor(gv)} y2={yFor(gv)} stroke="currentColor" className="text-line" strokeWidth={1} />
            <text x={0} y={yFor(gv) + 3} fontSize={9} className="fill-fg-faint">
              {mode === 'share' ? `${Math.round(gv * 100)}%` : formatAxisValue(measure, gv)}
            </text>
          </g>
        ))}
        {bands.map((day, i) => {
          if (i === 0) return null
          const prev = bands[i - 1]
          return day.bands.map((band, bi) => {
            const prevBand = prev.bands[bi]
            const dimmed = selected !== null && selected !== band.projectDir
            const color = projectColorFor(band.projectDir)
            const points = [
              `${xFor(i - 1)},${yFor(prevBand.y0)}`,
              `${xFor(i)},${yFor(band.y0)}`,
              `${xFor(i)},${yFor(band.y1)}`,
              `${xFor(i - 1)},${yFor(prevBand.y1)}`,
            ].join(' ')
            return (
              <polygon
                key={`${band.projectDir}-${i}`}
                points={points}
                fill={color}
                opacity={dimmed ? 0.12 : 0.75}
                className="cursor-pointer"
                onClick={() => onSelect(selected === band.projectDir ? null : band.projectDir)}
              >
                <title>{projectNameFromCwd(band.projectDir) ?? band.projectDir}</title>
              </polygon>
            )
          })
        })}
        {bands.map((day, i) => {
          if (i % labelEvery !== 0 && i !== bands.length - 1) return null
          return (
            <text key={day.date} x={xFor(i)} y={HEIGHT - 4} fontSize={9} textAnchor="middle" className="fill-fg-faint">
              {day.date.slice(5)}
            </text>
          )
        })}
      </svg>
    </div>
  )
}
