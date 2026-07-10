import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { EmptyState } from '../ui/EmptyState'
import type { DayProjectRow, HistoryAggregateResult } from '../../../preload/api'
import { CHART_CATEGORICAL, categoricalColor, HEAT_RAMP } from '../../lib/chartPalette'

type MetricKey = 'promptCount' | 'inputTokens' | 'outputTokens' | 'sessionCount' | 'errorCount' | 'estimatedCostUsd'
type SortDir = 'asc' | 'desc'

const METRIC_LABELS: Record<MetricKey, string> = {
  promptCount: 'Prompt count',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  sessionCount: 'Sessions',
  errorCount: 'Errors',
  estimatedCostUsd: 'Est. cost',
}

// Fixed per-model accent so a model's color is stable across renders/filters,
// not index-derived like the project palette. 'other' covers unmapped ids.
const MODEL_COLOR: Record<string, string> = {
  opus: 'bg-accent',
  sonnet: 'bg-sage',
  haiku: 'bg-butter',
  other: 'bg-hive-slate',
}

function modelColorFor(modelId: string): string {
  const id = modelId.toLowerCase()
  if (id.includes('opus')) return MODEL_COLOR.opus
  if (id.includes('sonnet')) return MODEL_COLOR.sonnet
  if (id.includes('haiku')) return MODEL_COLOR.haiku
  return MODEL_COLOR.other
}

const TABLE_COLS = [
  { key: 'project', label: 'project' },
  { key: 'daysActive', label: 'days' },
  { key: 'totalSessions', label: 'sessions' },
  { key: 'totalPrompts', label: 'prompts' },
  { key: 'totalInput', label: 'input tok' },
  { key: 'totalOutput', label: 'output tok' },
  { key: 'topTool', label: 'top tool' },
  { key: 'estimatedCostUsd', label: 'est. cost' },
] as const

type TableColKey = typeof TABLE_COLS[number]['key']

interface ProjectAgg {
  projectCwd: string
  daysActive: Set<string>
  totalSessions: number
  totalPrompts: number
  totalInput: number
  totalOutput: number
  topTool: string
  toolBreakdown: Record<string, number>
  estimatedCostUsd: number
}

interface Props {
  fromDate: string
  toDate: string
  projectFilter: string
  onProjectClick: (cwd: string) => void
}

// Auto-refresh interval — long enough to avoid hammering the aggregator
// (which walks every JSONL on disk) but short enough that an active session
// shows up in the dashboard without the user reaching for the refresh button.
const REFRESH_INTERVAL_MS = 30_000

export function HistoryDashboard({ fromDate, toDate, projectFilter, onProjectClick }: Props) {
  const [result, setResult] = useState<HistoryAggregateResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<MetricKey>('estimatedCostUsd')
  const [sortCol, setSortCol] = useState<TableColKey>('estimatedCostUsd')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  // `tick` bumps to force a refetch — incremented by the manual refresh button
  // and by a 30s interval so a live session's numbers eventually flow in
  // without the user having to do anything.
  const [tick, setTick] = useState(0)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [heatMetric, setHeatMetric] = useState<'cost' | 'sessions' | 'tokens'>('cost')

  useEffect(() => {
    let cancelled = false
    // Suppress the full-screen "scanning…" empty state on background
    // refreshes — only show it on the first load or when the user changed
    // the date range. Otherwise auto-refresh would flash the empty state
    // every 30s.
    if (lastFetchedAt === null) setLoading(true)
    setError(null)
    window.api.history.aggregate({ fromDate, toDate })
      .then((r) => {
        if (cancelled) return
        setResult(r)
        setLastFetchedAt(Date.now())
        setLoading(false)
      })
      .catch((e: unknown) => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
    // lastFetchedAt is intentionally omitted: it's a derived effect output,
    // not an input. Including it would re-fire the effect after every fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate, tick])

  // Reset the first-load gate when the date range changes so the user sees
  // a "scanning…" affordance, not a stale chart, while the new range fetches.
  useEffect(() => {
    setLastFetchedAt(null)
  }, [fromDate, toDate])

  // Auto-refresh tick.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])

  const filteredRows = useMemo<DayProjectRow[]>(() => {
    if (!result) return []
    if (!projectFilter.trim()) return result.rows
    const q = projectFilter.toLowerCase()
    return result.rows.filter((r) => r.projectCwd.toLowerCase().includes(q))
  }, [result, projectFilter])

  const projectAggs = useMemo<ProjectAgg[]>(() => {
    const map = new Map<string, ProjectAgg>()
    for (const row of filteredRows) {
      if (!map.has(row.projectCwd)) {
        map.set(row.projectCwd, {
          projectCwd: row.projectCwd,
          daysActive: new Set(),
          totalSessions: 0,
          totalPrompts: 0,
          totalInput: 0,
          totalOutput: 0,
          topTool: '',
          toolBreakdown: {},
          estimatedCostUsd: 0,
        })
      }
      const agg = map.get(row.projectCwd)!
      agg.daysActive.add(row.date)
      agg.totalSessions += row.sessionCount
      agg.totalPrompts += row.promptCount
      agg.totalInput += row.inputTokens
      agg.totalOutput += row.outputTokens
      agg.estimatedCostUsd += row.estimatedCostUsd
      for (const [tool, cnt] of Object.entries(row.toolBreakdown)) {
        agg.toolBreakdown[tool] = (agg.toolBreakdown[tool] ?? 0) + cnt
      }
    }
    for (const agg of map.values()) {
      let top = ''
      let topCnt = 0
      for (const [tool, cnt] of Object.entries(agg.toolBreakdown)) {
        if (cnt > topCnt) { topCnt = cnt; top = tool }
      }
      agg.topTool = top
    }
    return Array.from(map.values())
  }, [filteredRows])

  const totals = useMemo(() => {
    let promptCount = 0, inputTokens = 0, outputTokens = 0, sessionCount = 0, estimatedCostUsd = 0
    for (const r of filteredRows) {
      promptCount += r.promptCount
      inputTokens += r.inputTokens
      outputTokens += r.outputTokens
      sessionCount += r.sessionCount
      estimatedCostUsd += r.estimatedCostUsd
    }
    return { promptCount, inputTokens, outputTokens, sessionCount, estimatedCostUsd }
  }, [filteredRows])

  // Per-model spend + cache-hit totals across all filtered rows. Follows the
  // same reduce-into-map-then-sort pattern as projectAggs above.
  const modelTotals = useMemo(() => {
    const map = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }>()
    for (const row of filteredRows) {
      for (const [modelId, bucket] of Object.entries(row.byModel ?? {})) {
        const cur = map.get(modelId) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }
        cur.inputTokens += bucket.inputTokens
        cur.outputTokens += bucket.outputTokens
        cur.cacheReadTokens += bucket.cacheReadTokens
        cur.costUsd += bucket.costUsd
        map.set(modelId, cur)
      }
    }
    const entries = Array.from(map.entries())
      .map(([modelId, t]) => ({ modelId, ...t }))
      .sort((a, b) => b.costUsd - a.costUsd)
    const totalCostUsd = entries.reduce((sum, e) => sum + e.costUsd, 0)
    let cacheRead = 0, inputPlusCacheRead = 0
    for (const e of entries) {
      cacheRead += e.cacheReadTokens
      inputPlusCacheRead += e.inputTokens + e.cacheReadTokens
    }
    const cacheHitPct = inputPlusCacheRead > 0 ? (cacheRead / inputPlusCacheRead) * 100 : 0
    return { entries, totalCostUsd, cacheHitPct }
  }, [filteredRows])

  // Per-date input/output token sums for the stacked-bar chart below. O(rows).
  const stackedBars = useMemo(() => {
    const byDate = new Map<string, { date: string; input: number; output: number; cost: number }>()
    for (const r of filteredRows) {
      let cur = byDate.get(r.date)
      if (!cur) { cur = { date: r.date, input: 0, output: 0, cost: 0 }; byDate.set(r.date, cur) }
      cur.input += r.inputTokens
      cur.output += r.outputTokens
      cur.cost += r.estimatedCostUsd
    }
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date))
  }, [filteredRows])

  // Per-day totals across ALL filtered projects (summed, unlike per-project chartData). O(rows).
  const dailyTotals = useMemo<Map<string, { cost: number; sessions: number; tokens: number }>>(() => {
    const m = new Map<string, { cost: number; sessions: number; tokens: number }>()
    for (const r of filteredRows) {
      const cur = m.get(r.date) ?? { cost: 0, sessions: 0, tokens: 0 }
      cur.cost += r.estimatedCostUsd
      cur.sessions += r.sessionCount
      cur.tokens += r.inputTokens + r.outputTokens
      m.set(r.date, cur)
    }
    return m
  }, [filteredRows])

  // Full inclusive fromDate→toDate calendar grid, grouped into Sunday-start week
  // columns. O(days-in-range) — range is bounded to ~365 days by the date picker,
  // so this is not a complexity hazard.
  const heatWeeks = useMemo<{ date: string | null; value: number }[][]>(() => {
    const [fy, fm, fd] = fromDate.split('-').map(Number)
    const [ty, tm, td] = toDate.split('-').map(Number)
    const start = new Date(fy, fm - 1, fd)
    const end = new Date(ty, tm - 1, td)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []

    const days: { date: string; value: number }[] = []
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const totals = dailyTotals.get(key)
      const value = !totals ? 0
        : heatMetric === 'cost' ? totals.cost
        : heatMetric === 'sessions' ? totals.sessions
        : totals.tokens
      days.push({ date: key, value })
    }
    if (!days.length) return []

    const leadingBlanks = start.getDay()
    const cells: { date: string | null; value: number }[] = [
      ...Array.from({ length: leadingBlanks }, () => ({ date: null, value: 0 })),
      ...days,
    ]
    const weeks: { date: string | null; value: number }[][] = []
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
    return weeks
  }, [fromDate, toDate, dailyTotals, heatMetric])

  const heatMax = useMemo(() => {
    let max = 0
    for (const week of heatWeeks) for (const cell of week) if (cell.date) max = Math.max(max, cell.value)
    return max
  }, [heatWeeks])

  function heatBucket(value: number): number {
    if (value <= 0 || heatMax === 0) return 0
    return 1 + Math.min(3, Math.max(0, Math.floor((value / heatMax) * 4 - 1e-9)))
  }

  function formatHeatValue(value: number): string {
    if (heatMetric === 'cost') return `$${value.toFixed(4)}`
    if (heatMetric === 'sessions') return `${value} session${value === 1 ? '' : 's'}`
    return `${formatTokens(value)} tokens`
  }

  const { chartData, projectKeys } = useMemo(() => {
    const projects = [...new Set(filteredRows.map((r) => r.projectCwd))]
    const byDate = new Map<string, Record<string, number | string>>()
    for (const row of filteredRows) {
      if (!projects.includes(row.projectCwd)) continue
      if (!byDate.has(row.date)) byDate.set(row.date, { date: row.date })
      const entry = byDate.get(row.date)!
      const cur = typeof entry[row.projectCwd] === 'number' ? (entry[row.projectCwd] as number) : 0
      entry[row.projectCwd] = cur + (row[metric] as number)
    }
    const data = Array.from(byDate.values()).sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    )
    return { chartData: data, projectKeys: projects.slice(0, 10) }
  }, [filteredRows, metric])

  const sortedProjects = useMemo<ProjectAgg[]>(() => {
    return [...projectAggs].sort((a, b) => {
      let cmp = 0
      switch (sortCol) {
        case 'project': cmp = a.projectCwd.localeCompare(b.projectCwd); break
        case 'daysActive': cmp = a.daysActive.size - b.daysActive.size; break
        case 'totalSessions': cmp = a.totalSessions - b.totalSessions; break
        case 'totalPrompts': cmp = a.totalPrompts - b.totalPrompts; break
        case 'totalInput': cmp = a.totalInput - b.totalInput; break
        case 'totalOutput': cmp = a.totalOutput - b.totalOutput; break
        case 'estimatedCostUsd': cmp = a.estimatedCostUsd - b.estimatedCostUsd; break
        default: cmp = 0
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [projectAggs, sortCol, sortDir])

  const handleSort = (col: TableColKey) => {
    if (col === 'topTool') return
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortCol(col); setSortDir('desc') }
  }

  const refresh = () => setTick((t) => t + 1)

  if (loading) return <EmptyState title="scanning transcripts…" />
  if (error) return <EmptyState title="scan failed" hint={error} />
  if (!filteredRows.length) return (
    <EmptyState
      title="no sessions in range"
      hint="Widen the date range, clear the project filter, or click ↻ to rescan."
    />
  )

  return (
    <div data-testid="history-dashboard" className="p-4 space-y-6">
      {result?.partial && (
        <div className="text-xs text-yellow-400 border border-yellow-800 bg-yellow-950/30 rounded px-3 py-2">
          Scan took longer than expected — showing partial results. Full results may differ.
        </div>
      )}

      <div className="flex items-center justify-end gap-2 text-xs text-fg-faint">
        <FreshnessIndicator lastFetchedAt={lastFetchedAt} />
        <button
          onClick={refresh}
          className="px-2 py-0.5 border border-line rounded hover:text-fg hover:bg-bg-hi"
          title="Rescan transcripts"
        >
          ↻ refresh
        </button>
      </div>

      <div className="grid grid-cols-5 gap-3">
        <Stat label="total prompts" value={totals.promptCount.toLocaleString()} />
        <Stat label="input tokens" value={totals.inputTokens.toLocaleString()} />
        <Stat label="output tokens" value={totals.outputTokens.toLocaleString()} />
        <Stat label="sessions" value={totals.sessionCount.toLocaleString()} />
        <Stat label="est. cost" value={`$${totals.estimatedCostUsd.toFixed(4)}`} highlight />
      </div>

      <div className="border border-line rounded bg-bg-elev p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-fg-faint uppercase tracking-wider">daily metric</span>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as MetricKey)}
            className="bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
          >
            {(Object.entries(METRIC_LABELS) as [MetricKey, string][]).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        {projectKeys.length >= 10 && (
          <div className="text-xs text-fg-faint mb-2">10 projects shown</div>
        )}
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData}>
            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} width={60} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {projectKeys.map((proj, i) => (
              <Line
                key={proj}
                type="monotone"
                dataKey={proj}
                name={proj.length > 30 ? '…' + proj.slice(-28) : proj}
                stroke={categoricalColor(i)}
                dot={false}
                strokeWidth={1.5}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-line rounded bg-bg-elev p-4">
          <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Spend by model</h3>
          {modelTotals.entries.length === 0 ? (
            <div className="text-xs text-fg-faint">no model data in range</div>
          ) : (
            <div className="space-y-2">
              {modelTotals.entries.map((e) => {
                const pct = modelTotals.totalCostUsd > 0 ? (e.costUsd / modelTotals.totalCostUsd) * 100 : 0
                return (
                  <div key={e.modelId}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="flex items-center gap-1.5 font-mono text-fg-dim truncate">
                        <span className={`w-2 h-2 rounded-sm shrink-0 ${modelColorFor(e.modelId)}`} />
                        {e.modelId}
                      </span>
                      <span className="text-fg-faint whitespace-nowrap ml-2">
                        ${e.costUsd.toFixed(4)} · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded bg-bg-hi overflow-hidden">
                      <div className={`h-full ${modelColorFor(e.modelId)}`} style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="border border-line rounded bg-bg-elev p-4">
          <h3 className="text-xs uppercase tracking-wider text-fg mb-3">Cache savings</h3>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="cache-hit rate" value={`${modelTotals.cacheHitPct.toFixed(1)}%`} />
            {/* cacheSavingsUsd is a top-level, date-range-scoped figure computed
                server-side (historyAggregator.cjs) since only it has the
                per-model pricing table; it isn't re-scoped by the project
                text filter the way modelTotals is. */}
            <Stat label="$ saved" value={`$${(result?.cacheSavingsUsd ?? 0).toFixed(4)}`} highlight />
          </div>
        </div>
      </div>

      <div className="border border-line rounded bg-bg-elev p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs uppercase tracking-wider text-fg">Activity heatmap</h3>
          <div className="flex border border-line rounded overflow-hidden text-[10px]">
            {(['cost', 'sessions', 'tokens'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setHeatMetric(m)}
                className={`px-2 py-0.5 ${heatMetric === m ? 'bg-accent text-white' : 'text-fg-faint hover:text-fg'}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto">
          <div className="flex flex-col gap-[2px] pr-1 text-[9px] text-fg-faint justify-between">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i}>{d}</span>)}
          </div>
          <div className="flex gap-[2px]">
            {heatWeeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[2px]">
                {week.map((cell, di) => (
                  <div
                    key={di}
                    className="w-[10px] h-[10px] rounded-[2px]"
                    style={{ background: cell.date ? HEAT_RAMP[heatBucket(cell.value)] : 'transparent' }}
                    title={cell.date ? `${cell.date} · ${formatHeatValue(cell.value)}` : undefined}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="border border-line rounded bg-bg-elev p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-xs uppercase tracking-wider text-fg">Input vs output tokens</h3>
          <div className="flex items-center gap-3 text-[10px] text-fg-faint">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: CHART_CATEGORICAL[0] }} />input</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: CHART_CATEGORICAL[4] }} />output</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={128}>
          <BarChart data={stackedBars}>
            <XAxis dataKey="date" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} width={60} />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || !payload.length) return null
                const d = payload[0]?.payload as { date: string; input: number; output: number; cost: number }
                return (
                  <div className="bg-bg-elev border border-line rounded px-2 py-1 text-[10px] text-fg">
                    <div>{label}</div>
                    <div>in {formatTokens(d.input)}</div>
                    <div>out {formatTokens(d.output)}</div>
                    <div>${d.cost.toFixed(4)}</div>
                  </div>
                )
              }}
            />
            <Bar dataKey="input" stackId="tok" fill={CHART_CATEGORICAL[0]} />
            <Bar dataKey="output" stackId="tok" fill={CHART_CATEGORICAL[4]} />
          </BarChart>
        </ResponsiveContainer>
        <div className="flex justify-between mt-2 text-[10px] text-fg-faint">
          <span>in {formatTokens(totals.inputTokens)}</span>
          <span>out {formatTokens(totals.outputTokens)}</span>
          <span>est. cost ${totals.estimatedCostUsd.toFixed(2)}</span>
        </div>
      </div>

      <div className="border border-line rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-bg-elev sticky top-0">
            <tr>
              {TABLE_COLS.map(({ key, label }) => (
                <th
                  key={key}
                  onClick={() => handleSort(key)}
                  className={`text-left px-3 py-2 text-fg-faint uppercase tracking-wider whitespace-nowrap ${key !== 'topTool' ? 'cursor-pointer hover:text-fg' : ''}`}
                >
                  {label}
                  {sortCol === key && (
                    <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedProjects.map((agg) => (
              <tr
                key={agg.projectCwd}
                onClick={() => onProjectClick(agg.projectCwd)}
                className="border-t border-line hover:bg-bg-elev cursor-pointer"
              >
                <td
                  className="px-3 py-2 font-mono text-fg-dim max-w-xs"
                  title={agg.projectCwd}
                >
                  <span className="block truncate">
                    {agg.projectCwd.length > 40 ? '…' + agg.projectCwd.slice(-38) : agg.projectCwd}
                  </span>
                </td>
                <td className="px-3 py-2 text-fg-faint">{agg.daysActive.size}</td>
                <td className="px-3 py-2 text-fg-faint">{agg.totalSessions}</td>
                <td className="px-3 py-2 text-fg-faint">{agg.totalPrompts.toLocaleString()}</td>
                <td className="px-3 py-2 text-fg-faint">{agg.totalInput.toLocaleString()}</td>
                <td className="px-3 py-2 text-fg-faint">{agg.totalOutput.toLocaleString()}</td>
                <td className="px-3 py-2 text-fg-faint font-mono">{agg.topTool || '—'}</td>
                <td className="px-3 py-2 text-accent">${agg.estimatedCostUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-fg-faint">
        path shown is path at session time — renames create separate rows.
        cost estimate uses per-model pricing (Opus/Sonnet/Haiku); unrecognized models are estimated at Sonnet rates; actual cost may differ from billing.
      </div>
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="border border-line rounded p-3 bg-bg-elev">
      <div className="text-xs text-fg-faint uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-mono ${highlight ? 'text-accent' : 'text-fg'}`}>{value}</div>
    </div>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

function FreshnessIndicator({ lastFetchedAt }: { lastFetchedAt: number | null }) {
  // Ticks once per second so the displayed age stays current without
  // forcing the dashboard to re-render every tick.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  if (lastFetchedAt === null) return null
  const age = Math.max(0, now - lastFetchedAt)
  const text =
    age < 5_000 ? 'just now'
    : age < 60_000 ? `updated ${Math.floor(age / 1000)}s ago`
    : age < 3_600_000 ? `updated ${Math.floor(age / 60_000)}m ago`
    : `updated ${Math.floor(age / 3_600_000)}h ago`
  return <span className="font-mono tabular-nums">{text}</span>
}
