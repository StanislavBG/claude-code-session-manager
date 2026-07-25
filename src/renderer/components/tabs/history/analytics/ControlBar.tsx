import type { Measure } from '../../../../lib/analyticsViewModel'
import { MEASURE_LABELS } from '../../../../lib/analyticsViewModel'

export type RangeDays = 30 | 60 | 90 | 0

const MEASURES: Measure[] = ['in', 'out', 'total', 'prompts', 'sessions', 'time', 'spend']
const RANGES: { value: RangeDays; label: string }[] = [
  { value: 30, label: '30d' },
  { value: 60, label: '60d' },
  { value: 90, label: '90d' },
  { value: 0, label: 'All time' },
]

interface Props {
  measure: Measure
  onMeasure: (m: Measure) => void
  range: RangeDays
  onRange: (r: RangeDays) => void
  projectsShown: number
  projectsTotal: number
  fromDate: string
  toDate: string
  onRefresh: () => void
  onExport: () => void
  exportDisabled: boolean
}

function Segmented<T extends string | number>({ value, options, onChange }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex border border-line rounded overflow-hidden text-[11px]">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          onClick={() => onChange(opt.value)}
          className={`px-2 py-1 whitespace-nowrap ${value === opt.value ? 'bg-accent text-white' : 'text-fg-faint hover:text-fg hover:bg-bg-hi'}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function ControlBar({
  measure, onMeasure, range, onRange, projectsShown, projectsTotal,
  fromDate, toDate, onRefresh, onExport, exportDisabled,
}: Props) {
  return (
    <div className="sticky top-0 z-10 bg-bg border-b border-line px-4 py-2.5 flex flex-wrap items-center gap-3">
      <Segmented
        value={measure}
        options={MEASURES.map((m) => ({ value: m, label: MEASURE_LABELS[m] }))}
        onChange={onMeasure}
      />
      <Segmented value={range} options={RANGES} onChange={onRange} />
      <span className="text-[11px] text-fg-faint font-mono">
        {projectsShown} / {projectsTotal} projects
      </span>
      <span className="text-[11px] text-fg-faint font-mono">
        {fromDate} → {toDate}
      </span>
      <div className="flex-1" />
      <button
        onClick={onRefresh}
        className="px-2 py-1 text-[11px] border border-line rounded hover:text-fg hover:bg-bg-hi text-fg-faint"
        title="Re-fetch the rollup (no scan)"
      >
        ↻ Refresh
      </button>
      <button
        onClick={onExport}
        disabled={exportDisabled}
        className="px-2 py-1 text-[11px] border border-line rounded hover:text-fg hover:bg-bg-hi text-fg-faint disabled:opacity-40 disabled:pointer-events-none"
      >
        Export CSV
      </button>
    </div>
  )
}
