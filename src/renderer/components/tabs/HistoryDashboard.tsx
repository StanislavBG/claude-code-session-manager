import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import type { HistoryDashboardDay, HistoryDashboardResult, HistoryDashboardTotals } from '../../../preload/api'
import { facetSlice } from '../../lib/historyFacet'
import { buildHeadline, buildProjectRows, measureValue, type Measure } from '../../lib/analyticsViewModel'
import { buildUsageCsv } from '../../lib/usageCsv'
import { toast } from '../../state/toast'
import { useLayout } from '../../state/layout'
import { useSessions } from '../../state/sessions'
import { ControlBar, type RangeDays } from './history/analytics/ControlBar'
import { Headline } from './history/analytics/Headline'
import { BudgetStrip } from './history/analytics/BudgetStrip'
import { ProjectFacet } from './history/analytics/ProjectFacet'
import { StackedTrend } from './history/analytics/StackedTrend'
import { Ranking } from './history/analytics/Ranking'
import { ProjectDrill, type DrillModelBucket } from './history/analytics/ProjectDrill'
import { ModelMix } from './history/analytics/panels/ModelMix'
import { Concentration } from './history/analytics/panels/Concentration'
import { CachePanel } from './history/analytics/panels/CachePanel'
import { Rhythm } from './history/analytics/panels/Rhythm'

const MEASURE_KEY = 'sm.history.analytics.measure'
const RANGE_KEY = 'sm.history.analytics.range'
const MEASURES: Measure[] = ['in', 'out', 'total', 'prompts', 'sessions', 'time', 'spend']
const RANGES: RangeDays[] = [30, 60, 90, 0]

function loadMeasure(): Measure {
  try {
    const v = localStorage.getItem(MEASURE_KEY)
    if (v && (MEASURES as string[]).includes(v)) return v as Measure
  } catch { /* quota / private mode — ignore */ }
  return 'spend'
}

function loadRange(): RangeDays {
  try {
    const v = Number(localStorage.getItem(RANGE_KEY))
    if ((RANGES as number[]).includes(v)) return v as RangeDays
  } catch { /* quota / private mode — ignore */ }
  return 30
}

function emptyTotals(): HistoryDashboardTotals {
  return {
    promptCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    toolCallCount: 0, sessionCount: 0, errorCount: 0, activeMinutes: 0, estimatedCostUsd: 0,
  }
}

export function HistoryDashboard() {
  const [measure, setMeasure] = useState<Measure>(loadMeasure)
  const [range, setRange] = useState<RangeDays>(loadRange)

  // The Project face is FORCE-scoped to the active tab's project — no
  // manual override, no escape hatch (matches Scheduler's Project-face
  // scoping). `homeKeep` is the free-form multi-project filter state used
  // ONLY on the Home face (toggle/isolate/showAll below); `keep` derives
  // from it there, but on the Project face `keep` is always exactly
  // `{activeCwd}`, recomputed every render — a prior manual filter set
  // while on Home face must never leak through a transition into Project
  // face. Transitioning back to Home resets `homeKeep` to "all" rather than
  // resurrecting whatever was filtered before leaving, since there's no
  // longer any way to have "manually touched" the filter while away.
  const navFace = useLayout((s) => s.navFace)
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeCwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null
  const prevNavFaceRef = useRef(navFace)

  const [homeKeep, setHomeKeep] = useState<Set<string> | null>(null)
  const keep = useMemo(
    () => (navFace === 'project' && activeCwd ? new Set([activeCwd]) : homeKeep),
    [navFace, activeCwd, homeKeep],
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [raw, setRaw] = useState<HistoryDashboardResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => { try { localStorage.setItem(MEASURE_KEY, measure) } catch { /* ignore */ } }, [measure])
  useEffect(() => { try { localStorage.setItem(RANGE_KEY, String(range)) } catch { /* ignore */ } }, [range])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.history.dashboard({ rangeDays: range })
      .then((r) => { if (!cancelled) { setRaw(r); setLoading(false) } })
      .catch((e: unknown) => {
        if (cancelled) return
        setLoading(false)
        toast.error(`History analytics failed to load: ${String(e)}`)
        // Deliberately does not clear `raw` — the last good payload stays on screen.
      })
    return () => { cancelled = true }
  }, [range, tick])

  // Reset the Home-face facet + selection when the range changes so a stale
  // project key from a prior range doesn't linger in `homeKeep`. Skips the
  // initial mount so it doesn't clobber the NavFace-seeded initial value
  // above. Project face's `keep` is derived, not stateful — nothing to reset.
  const rangeMountedRef = useRef(false)
  useEffect(() => {
    if (!rangeMountedRef.current) { rangeMountedRef.current = true; return }
    setHomeKeep(null)
    setSelected(null)
  }, [range])

  // Transitioning back to Home always resets to "show all" — there's no
  // manual-touch state to preserve, since the Project face (the only place
  // you could have come from) offers no filter UI to have touched.
  useEffect(() => {
    if (prevNavFaceRef.current === navFace) return
    prevNavFaceRef.current = navFace
    if (navFace === 'home') setHomeKeep(null)
  }, [navFace])

  const facet = useMemo(() => (raw ? facetSlice(raw, keep) : null), [raw, keep])

  const filteredDays = useMemo<HistoryDashboardDay[]>(() => {
    if (!raw) return []
    if (keep === null) return raw.days
    return raw.days.map((d) => ({
      date: d.date,
      byProject: Object.fromEntries(Object.entries(d.byProject).filter(([p]) => keep.has(p))),
    }))
  }, [raw, keep])

  const allProjectRows = useMemo(() => (raw ? buildProjectRows(raw.days, measure) : []), [raw, measure])
  const projectRows = useMemo(() => buildProjectRows(filteredDays, measure), [filteredDays, measure])

  const stackedDays = useMemo(() => filteredDays.map((d) => ({
    date: d.date,
    values: Object.fromEntries(Object.entries(d.byProject).map(([p, row]) => [p, measureValue(row, measure)])),
  })), [filteredDays, measure])

  const headline = useMemo(() => (facet ? buildHeadline(facet, measure) : null), [facet, measure])

  const selectedDrill = useMemo(() => {
    if (!raw || !selected) return null
    const totals = emptyTotals()
    const byModel: Record<string, DrillModelBucket> = {}
    const toolBreakdown: Record<string, number> = {}
    for (const day of raw.days) {
      const row = day.byProject[selected]
      if (!row) continue
      totals.promptCount += row.promptCount
      totals.inputTokens += row.inputTokens
      totals.outputTokens += row.outputTokens
      totals.cacheReadTokens += row.cacheReadTokens
      totals.cacheCreationTokens += row.cacheCreationTokens
      totals.toolCallCount += row.toolCallCount
      totals.sessionCount += row.sessionCount
      totals.errorCount += row.errorCount
      totals.activeMinutes += row.activeMinutes
      totals.estimatedCostUsd += row.estimatedCostUsd
      for (const [modelId, mb] of Object.entries(row.byModel)) {
        const dst = byModel[modelId] ?? (byModel[modelId] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 })
        dst.inputTokens += mb.inputTokens
        dst.outputTokens += mb.outputTokens
        dst.cacheReadTokens += mb.cacheReadTokens
        dst.cacheCreationTokens += mb.cacheCreationTokens
        dst.costUsd += mb.costUsd
      }
      for (const [tool, cnt] of Object.entries(row.toolBreakdown)) {
        toolBreakdown[tool] = (toolBreakdown[tool] ?? 0) + cnt
      }
    }
    return { totals, byModel, toolBreakdown }
  }, [raw, selected])

  // Clear selection if its project gets faceted out.
  useEffect(() => {
    if (selected && keep !== null && !keep.has(selected)) setSelected(null)
  }, [selected, keep])

  // Only reachable via ProjectFacet below, which only renders on the Home
  // face — these mutate homeKeep, never the Project face's forced `keep`.
  function toggleProject(projectDir: string) {
    setHomeKeep((prev) => {
      const all = new Set(allProjectRows.map((r) => r.projectDir))
      const cur = prev ?? new Set(all)
      const next = new Set(cur)
      if (next.has(projectDir)) next.delete(projectDir)
      else next.add(projectDir)
      return next.size >= all.size ? null : next
    })
  }
  function isolateProject(projectDir: string) {
    setHomeKeep(new Set([projectDir]))
  }
  function showAll() {
    setHomeKeep(null)
  }

  function handleExport() {
    if (!raw) return
    const csvDays = filteredDays.map((d) => {
      let costUsd = 0, inputTokens = 0, outputTokens = 0, cacheCreationTokens = 0, cacheReadTokens = 0
      const byModel: Record<string, DrillModelBucket> = {}
      for (const row of Object.values(d.byProject)) {
        costUsd += row.estimatedCostUsd
        inputTokens += row.inputTokens
        outputTokens += row.outputTokens
        cacheCreationTokens += row.cacheCreationTokens
        cacheReadTokens += row.cacheReadTokens
        for (const [modelId, mb] of Object.entries(row.byModel)) {
          const dst = byModel[modelId] ?? (byModel[modelId] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 })
          dst.inputTokens += mb.inputTokens
          dst.outputTokens += mb.outputTokens
          dst.cacheReadTokens += mb.cacheReadTokens
          dst.cacheCreationTokens += mb.cacheCreationTokens
        }
      }
      return { date: d.date, costUsd, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, byModel }
    })
    const csv = buildUsageCsv(csvDays)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `usage-history-${raw.from}-${raw.to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading && !raw) return <HistorySkeleton />
  if (raw && raw.days.length === 0) {
    return <EmptyState title="no sessions in range" hint="Widen the range or check back after your next session." />
  }
  if (!raw || !facet || !headline) return <HistorySkeleton />

  return (
    <div data-testid="history-dashboard" className="flex flex-col h-full">
      <h1 className="font-serif text-[42px] leading-tight tracking-tight text-fg px-4 pt-4">
        Where your <em className="italic text-accent">Claude time</em> goes
      </h1>
      <ControlBar
        measure={measure}
        onMeasure={setMeasure}
        range={range}
        onRange={setRange}
        projectsShown={keep === null ? allProjectRows.length : keep.size}
        projectsTotal={allProjectRows.length}
        fromDate={raw.from}
        toDate={raw.to}
        onRefresh={() => setTick((t) => t + 1)}
        onExport={handleExport}
        exportDisabled={filteredDays.length === 0}
      />
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
        <Headline
          measure={measure}
          headline={headline}
          activeDays={facet.activeDays}
          projectsTouched={projectRows.length}
          totalSessions={facet.totals.sessionCount}
        />
        <BudgetStrip days={raw.days} />
        {/* Project face is force-scoped to the active project (see `keep`
            above) — nothing to facet with only one project ever shown, and
            no escape hatch to peek at others. Home face keeps the full
            multi-project filter. */}
        {navFace === 'home' && (
          <ProjectFacet
            chips={allProjectRows.map((r) => ({ projectDir: r.projectDir, value: r.value }))}
            keep={keep}
            onToggle={toggleProject}
            onIsolate={isolateProject}
            onShowAll={showAll}
          />
        )}
        <StackedTrend days={stackedDays} measure={measure} selected={selected} onSelect={setSelected} />
        <Ranking rows={projectRows} measure={measure} selected={selected} onSelect={setSelected} />
        {selected && selectedDrill && (
          <ProjectDrill
            projectDir={selected}
            totals={selectedDrill.totals}
            byModel={selectedDrill.byModel}
            toolBreakdown={selectedDrill.toolBreakdown}
            onClear={() => setSelected(null)}
          />
        )}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <ModelMix byModelTotals={facet.byModelTotals} />
          <Concentration rows={projectRows} />
          <CachePanel totals={facet.totals} />
          <Rhythm days={facet.days} measure={measure} />
        </div>
      </div>
    </div>
  )
}

function HistorySkeleton() {
  return (
    <div className="p-4 space-y-4 animate-pulse">
      <div className="h-24 bg-bg-elev rounded" />
      <div className="h-16 bg-bg-elev rounded" />
      <div className="h-8 bg-bg-elev rounded" />
      <div className="h-56 bg-bg-elev rounded" />
      <div className="h-40 bg-bg-elev rounded" />
    </div>
  )
}
