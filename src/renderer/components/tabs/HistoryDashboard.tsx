import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { EmptyState } from '../ui/EmptyState'
import type { DayProjectRow, HistoryAggregateResult } from '../../../preload/api'

const PROJECT_COLORS = [
  '#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa',
  '#fb923c', '#38bdf8', '#4ade80', '#e879f9', '#fbbf24',
]

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

export function HistoryDashboard({ fromDate, toDate, projectFilter, onProjectClick }: Props) {
  const [result, setResult] = useState<HistoryAggregateResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<MetricKey>('estimatedCostUsd')
  const [sortCol, setSortCol] = useState<TableColKey>('estimatedCostUsd')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.api.history.aggregate({ fromDate, toDate })
      .then((r) => { if (!cancelled) { setResult(r); setLoading(false) } })
      .catch((e: unknown) => { if (!cancelled) { setError(String(e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [fromDate, toDate])

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

  if (loading) return <EmptyState title="scanning transcripts…" />
  if (error) return <EmptyState title="scan failed" hint={error} />
  if (!filteredRows.length) return (
    <EmptyState
      title="no completed sessions found"
      hint="Sessions from today are excluded; check back tomorrow."
    />
  )

  return (
    <div data-testid="history-dashboard" className="p-4 space-y-6">
      {result?.partial && (
        <div className="text-xs text-yellow-400 border border-yellow-800 bg-yellow-950/30 rounded px-3 py-2">
          Scan took longer than expected — showing partial results. Full results may differ.
        </div>
      )}

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
                stroke={PROJECT_COLORS[i % PROJECT_COLORS.length]}
                dot={false}
                strokeWidth={1.5}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
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
        cost estimate uses Sonnet-4.6 flat rate ($3/$15 per MTok); actual cost may differ.
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
