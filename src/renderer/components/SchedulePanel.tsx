import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ScheduleJob, ScheduleJobHold, ScheduleHealthSnapshot } from '../../preload/api.d'
import { toast } from '../state/toast'
import { formatTimingLabel, formatAgo } from '../lib/formatTime'
import { useScheduleState } from '../state/scheduleState'
import { usePromptSessions } from '../state/promptSessions'
import { FilterPills } from './ui/FilterPills'
import { AlmanacIcon } from './layout/AlmanacIcon'
import { projectNameFromCwd, InfoDot } from './tabs/scheduler/sched-primitives'
import { buildHeadChoicesBySlug, sectionHeadChoices } from './tabs/scheduler/DispositionControl'
import { buildBacklogTree, flattenBacklogNodes } from '../lib/backlogTree'
import { buildPlans } from '../lib/schedulerStages'
import { PlanBand } from './tabs/scheduler/PlanBand'
import { JobRow, EpicSectionBlock } from './tabs/scheduler/JobRow'
import { SupervisorPanel } from './tabs/scheduler/SupervisorPanel'
import { FirstRunGuide } from './tabs/scheduler/FirstRunGuide'
import { computeStatus, type StatusKind } from './tabs/scheduler/computeStatus'
import { SchedulerFooter } from './tabs/scheduler/SchedulerFooter'
import type { PlanMode } from './tabs/scheduler/SchedulerTopBands'
import { usePanelFocus } from '../lib/panelFocus'
import type { NavKey } from '../lib/navKey'

/** Inline completed-jobs cap. Older / overflow get rolled into the
 *  "+N more completed" collapse line. */
const COMPLETED_DISPLAY_CAP = 5
/** Anything completed more than this ago is auto-collapsed (with the
 *  cap above as a secondary limit on fresh completions). */
const COMPLETED_FRESH_MS = 24 * 60 * 60 * 1000
/** localStorage key for the user's "Clear completed" visual hides. The
 *  underlying queue.json is unchanged — this is renderer-side only. */
const HIDDEN_KEY = 'sm.scheduler.hiddenCompletedSlugs'
const FOCUSED_IDX_KEY = 'sm.scheduler.focusedJobIndex'
const LS_FILTER_KEY = 'sm.scheduler.queueFilter'

type FilterStatus = 'all' | 'running' | 'investigating' | 'pending' | 'completed' | 'skipped' | 'needs_review' | 'failed' | 'quarantined'
interface QueueFilter { text: string; status: FilterStatus }

const FILTER_STATUS_VALUES: FilterStatus[] = ['all', 'running', 'investigating', 'pending', 'completed', 'skipped', 'needs_review', 'failed', 'quarantined']

function loadFilter(): QueueFilter {
  try {
    const raw = localStorage.getItem(LS_FILTER_KEY)
    if (!raw) return { text: '', status: 'all' }
    const p = JSON.parse(raw)
    return {
      text: '',
      status: FILTER_STATUS_VALUES.includes(p.status) ? p.status : 'all',
    }
  } catch {
    return { text: '', status: 'all' }
  }
}

function saveFilter(f: QueueFilter) {
  try { localStorage.setItem(LS_FILTER_KEY, JSON.stringify({ status: f.status })) } catch { /* */ }
}

function applyFilter(jobs: ScheduleJob[], filter: QueueFilter): ScheduleJob[] {
  if (filter.status === 'all' && !filter.text) return jobs
  const q = filter.text.toLowerCase()
  return jobs.filter((j) => {
    if (filter.status !== 'all' && j.status !== filter.status) return false
    if (!q) return true
    const tag = projectNameFromCwd(j.cwd) ?? ''
    return (
      j.title.toLowerCase().includes(q) ||
      j.slug.toLowerCase().includes(q) ||
      tag.toLowerCase().includes(q)
    )
  })
}

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function saveHidden(set: Set<string>) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])) } catch { /* */ }
}

/**
 * SchedulePanel — Queue sub-view of the Scheduler tab. Shows policy controls,
 * filter chips, and an expandable job list wired to the live queue snapshot.
 */
export function SchedulePanel({ scopeCwd = null, navigate, filterText, planMode = 'graph', onOpenPrds, planToolsEl = null }: {
  scopeCwd?: string | null
  navigate?: (k: NavKey) => void
  /** 'list' = the vertical Epic tree (EpicSectionBlock + JobRow); 'graph' (default) and 'critical' = plan bands of stage columns. */
  planMode?: PlanMode
  /** Draft plan's 'Schedule…' — jump to the PRDs sub-view, opening `slug`. */
  onOpenPrds?: (slug: string | null) => void
  /** When provided, the Scheduler shell's PLANS-toolbar input owns the text filter (the in-panel input is hidden). */
  filterText?: string
  /** The PLANS toolbar's mount point (SchedulerTopBands). Graph mode portals its counts / status filter / overflow menu here instead of rendering a second toolbar row. */
  planToolsEl?: HTMLElement | null
}) {
  const rawSnap = useScheduleState((s) => s.snapshot)
  // Scheduler-as-browser (2026-07-31 domain model): the panel shows one
  // TAB/project's jobs when scoped. Derived AFTER selection (memoized) — never
  // build values inside a zustand selector (React #185 blank-app class).
  const snap = useMemo(() => {
    if (!rawSnap || !scopeCwd) return rawSnap
    return { ...rawSnap, jobs: rawSnap.jobs.filter((j) => j.cwd === scopeCwd) }
  }, [rawSnap, scopeCwd])
  const [health, setHealth] = useState<ScheduleHealthSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [hiddenSlugs, setHiddenSlugs] = useState<Set<string>>(() => loadHidden())
  const [showAllCompleted, setShowAllCompleted] = useState(false)
  const [filterState, setFilter] = useState<QueueFilter>(() => loadFilter())
  const filter = useMemo<QueueFilter>(
    () => (filterText === undefined ? filterState : { ...filterState, text: filterText }),
    [filterState, filterText],
  )
  const [meterBannerDismissed, setMeterBannerDismissed] = useState(false)
  const [panelView, setPanelView] = useState<'queue' | 'supervisor'>('queue')

  const jobListRef = useRef<HTMLDivElement>(null)
  const [focusedJobIdx, setFocusedJobIdx] = useState(() => {
    try { return Number(localStorage.getItem(FOCUSED_IDX_KEY)) || 0 } catch { return 0 }
  })

  const [announcement, setAnnouncement] = useState('')
  const focused = usePanelFocus()

  useEffect(() => {
    window.api.schedule.health().then(setHealth).catch(() => {})
    const off = window.api.schedule.onState(() => {
      window.api.schedule.health().then(setHealth).catch(() => {})
    })
    return off
  }, [])

  // Gated on panel focus — this ticker only drives relative-time labels, so a
  // backgrounded (but still mounted, dockview renderer:'always') Scheduler
  // panel stops re-rendering once a second for no visible benefit. Regaining
  // focus refreshes `now` immediately rather than waiting a full second.
  useEffect(() => {
    if (!focused) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [focused])

  const avgDurationMs = useMemo(() => {
    if (!snap) return 150_000
    const durs: number[] = []
    for (const j of snap.jobs) {
      if (j.status === 'completed' && j.startedAt && j.finishedAt) {
        const d = Date.parse(j.finishedAt) - Date.parse(j.startedAt)
        if (d > 0) durs.push(d)
      }
    }
    if (durs.length === 0) return 150_000
    return durs.reduce((a, b) => a + b, 0) / durs.length
  }, [snap])

  const prevJobStatuses = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    if (!snap) return
    const changed: string[] = []
    for (const j of snap.jobs) {
      const prev = prevJobStatuses.current.get(j.slug)
      if (prev && prev !== j.status) {
        changed.push(`${j.title}: ${prev} → ${j.status}`)
      }
      prevJobStatuses.current.set(j.slug, j.status)
    }
    if (changed.length > 0) setAnnouncement(changed.join('; '))
  }, [snap])

  // Per-row hold reasons from the scheduler's last tick. Built into a Map here
  // (not inside a selector) so no freshly-built value is ever returned from a
  // zustand selector — see CLAUDE.md's React #185 rule. Keyed by slug, so it is
  // deliberately unfiltered by scope: rows only ever look up their own slug.
  const holdBySlug = useMemo(() => {
    const m = new Map<string, ScheduleJobHold>()
    for (const h of snap?.lastTick?.holds ?? []) m.set(h.slug, h)
    return m
  }, [snap?.lastTick])

  // Epic → dependency-chain grouping for the job table below — the real
  // backlog hierarchy (see lib/backlogTree's header). Raw slice from the
  // store, never derived inside a selector (React #185 class). Memoized on
  // [snap, sessions] only (not on the 1s `now` ticker or the filter/hide
  // state below) so JobRow's React.memo keeps bailing out on ticks that
  // don't carry a new snapshot — see SchedulePanel.jobrow-render-count.test.
  const sessions = usePromptSessions((s) => s.sessions)
  const backlogSections = useMemo(
    // rawSnap.jobs (unscoped, every project) is passed as the blocker-
    // resolution set so a dependsOn on a job that merely lives in a
    // DIFFERENT project doesn't render as a false "blocked by X (missing)"
    // warning — see buildBacklogTree's own doc comment. Only snap.jobs
    // (cwd-scoped) is rendered as this view's sections/rows.
    () => (snap ? buildBacklogTree(snap.jobs, sessions, rawSnap?.jobs) : []),
    [snap, sessions, rawSnap],
  )

  // Graph mode — plans are derived from the FILTERED jobs, memoized on the snapshot
  // (never on the 1s `now` ticker) so every PlanRow keeps its identity across ticks
  // and PrdRow's React.memo bails out. Declared before the early returns (rules of hooks).
  const graphJobs = useMemo(() => (snap ? applyFilter(snap.jobs, filter) : []), [snap, filter])
  const cap = snap?.effectiveConcurrency?.cap
  const plans = useMemo(
    () => (planMode === 'list' ? [] : buildPlans(graphJobs, { sessions, avgDurationMs, concurrency: cap })),
    [planMode, graphJobs, sessions, avgDurationMs, cap],
  )
  // Stable per-row listIndex (DOM order) for the arrow-key handler, and per-row attach-behind targets.
  const indexBySlug = useMemo(() => {
    const m = new Map<string, number>()
    let i = 0
    for (const p of plans) for (const st of p.stages) for (const r of st.rows) m.set(r.slug, i++)
    return m
  }, [plans])
  const headChoicesBySlug = useMemo(() => buildHeadChoicesBySlug(backlogSections), [backlogSections])
  // 'Clear completed' hides (renderer-side only) — shared with List mode via hiddenSlugs.
  const graphHidden = hiddenSlugs

  // Hooks must run unconditionally on every render — declared here, before the
  // panelView/snap early returns below, so switching to the supervisor
  // sub-panel doesn't change the hook count between renders (React error #300:
  // "Rendered fewer hooks than expected").
  const handleJobListKeyDown = useCallback((e: React.KeyboardEvent) => {
    const rows = jobListRef.current?.querySelectorAll<HTMLButtonElement>('[data-job-row]')
    if (!rows || rows.length === 0) return
    // focusedJobIdx is the STABLE listIndex stamped on each row (assigned
    // once over the FULL backlog tree, independent of which Epic sections
    // are currently collapsed/filtered) — it is NOT a live position in
    // `rows`, which only contains whatever is actually rendered right now.
    // Collapsing an earlier section shortens/reorders `rows` without
    // renumbering listIndex, so treating focusedJobIdx as a raw index into
    // `rows` jumps focus to an unrelated row the moment the two diverge.
    // Look the current row up by its stable data-job-index instead, and
    // navigate relative to ITS live position.
    const rowsArr = Array.from(rows)
    const currentLiveIdx = rowsArr.findIndex((r) => r.dataset.jobIndex === String(focusedJobIdx))
    const focusRow = (liveIdx: number) => {
      const row = rowsArr[liveIdx]
      if (!row) return
      const stableIdx = Number(row.dataset.jobIndex)
      setFocusedJobIdx(stableIdx)
      try { localStorage.setItem(FOCUSED_IDX_KEY, String(stableIdx)) } catch { /* */ }
      row.focus()
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusRow(currentLiveIdx === -1 ? 0 : Math.min(currentLiveIdx + 1, rowsArr.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusRow(currentLiveIdx === -1 ? rowsArr.length - 1 : Math.max(currentLiveIdx - 1, 0))
    }
  }, [focusedJobIdx])

  // Stable identity so JobRow (React.memo) doesn't bail out of memoization on
  // every render just because the map created a fresh closure — declared
  // unconditionally alongside the other hooks above, before the early
  // returns below (rules of hooks).
  const handleRowFocused = useCallback((i: number) => {
    setFocusedJobIdx(i)
    try { localStorage.setItem(FOCUSED_IDX_KEY, String(i)) } catch { /* */ }
  }, [])

  if (!snap) return null

  if (panelView === 'supervisor') {
    return (
      <SupervisorPanel
        supervisorConfig={snap.config.supervisor}
        onSetConfig={(s) => window.api.schedule.setConfig({ supervisor: s })}
        onBack={() => setPanelView('queue')}
      />
    )
  }

  const { jobs, paused, lastRunAt, nextReset, effectiveConcurrency } = snap

  // First run — nothing queued for this scope yet. PRDs are authored by an
  // Epic's session, not written here, so the only real first step is
  // creating one; there is deliberately no "New PRD" button on this screen.
  if (jobs.length === 0) {
    return <FirstRunGuide navigate={navigate} />
  }

  const counts = { pending: 0, running: 0, investigating: 0, completed: 0, needs_review: 0, failed: 0 }
  for (const j of jobs) {
    if (j.status in counts) counts[j.status as keyof typeof counts]++
  }

  const runningJobs = jobs.filter((j) => j.status === 'running')
  const status = computeStatus({ snap, now, avgDurationMs, runningJobs })

  const filteredJobs = applyFilter(jobs, filter)

  const aheadCount = computeAheadCounts(filteredJobs)

  const { inline, collapsedCount } = partitionJobs(filteredJobs, hiddenSlugs, now, showAllCompleted)

  // Computed once per render (i.e. once per tick) rather than once per row
  // inline inside the JSX .map below — also finds the currently-running job
  // a single time instead of re-scanning `jobs` for every pending row.
  const etaMap = computeEtaMap(inline, jobs, aheadCount, avgDurationMs, status.kind, now)

  const onClearCompleted = () => {
    const next = new Set(hiddenSlugs)
    for (const j of jobs) if (j.status === 'completed' || j.status === 'failed') next.add(j.slug)
    setHiddenSlugs(next)
    saveHidden(next)
  }
  const onClearQueue = async () => {
    const victims = jobs.filter((j) => j.status !== 'running').length
    if (victims === 0) return
    const msg = `Archive ${victims} non-running PRD${victims === 1 ? '' : 's'} and remove from the queue?\n\nFiles are moved to prds-archived/<timestamp>/ and can be restored from disk. Running jobs are kept.`
    if (!window.confirm(msg)) return
    const r = await window.api.schedule.clearQueue()
    if (!r.ok) {
      toast.error(`Clear queue failed: ${(r as { error?: string }).error ?? 'unknown error'}`)
    }
  }
  const onUnhideAll = () => {
    setHiddenSlugs(new Set())
    saveHidden(new Set())
    setShowAllCompleted(false)
  }
  const hasInlineCompleted = planMode === 'list'
    ? inline.some((j) => j.status === 'completed')
    : jobs.some((j) => (j.status === 'completed' || j.status === 'skipped') && !hiddenSlugs.has(j.slug))
  const hiddenInGraph = jobs.filter((j) => (j.status === 'completed' || j.status === 'failed') && hiddenSlugs.has(j.slug)).length
  const isList = planMode === 'list'
  // Non-graph chrome keeps the 18px gutter in full-bleed (graph) mode; in List mode the max-width column pads it.
  const gutter = isList ? '' : 'px-[18px] py-2'

  return (
    <div className="overflow-y-auto h-full">
      {/* Screen-reader live region */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>

      <div className={isList ? 'px-9 py-6 max-w-[1100px] mx-auto space-y-4' : ''}>

        {/* FireStatus banner removed (2A): state word → title band, actions → title-band buttons (tabs/scheduler/SchedulerTopBands.tsx). */}

        {/* Meter rate-limited banner */}
        {health && health.consecutiveFailures > 5 && health.lastFailureKind === 'meter_rate_limited' && !paused && !meterBannerDismissed && (
          <div className={gutter}><div className={isList ? 'flex items-center gap-3 px-4 py-3 bg-amber-400/15 border border-amber-400/30 rounded-xl' : 'flex items-center gap-3 -mx-[18px] px-[18px] py-1 bg-amber-400/15 border-y border-amber-400/30'}>
            <span aria-hidden="true">⚠</span>
            <span className="text-[13.5px] text-amber-400/90">
              <strong className="font-semibold">Usage meter unavailable</strong> — last good reading{' '}
              {formatAgo(health.lastPollAt, now)}. Firing on a conservative estimate until it recovers.
            </span>
            <button
              type="button"
              onClick={() => setMeterBannerDismissed(true)}
              className="ml-auto text-[12px] text-amber-400/70 hover:text-amber-400 shrink-0"
              title="Dismiss this banner. The scheduler continues firing normally."
            >
              Dismiss
            </button>
          </div></div>
        )}

        {/* PolicyBar removed (2A): fire policy / cap / threshold → CONCURRENCY KPI cell; Fire + Refresh → title band. */}

        {/* Running concurrency badge — List mode only; Graph mode carries this in the SLOTS / READY KPI cells. */}
        {isList && runningJobs.length > 0 && (() => {
          const cap = effectiveConcurrency?.cap ?? 5
          const groupPending = jobs.filter((j) => j.status === 'pending').length
          return (
            <div className={`flex items-center gap-2 text-[12px] font-mono ${gutter}`}>
              <span className="px-2 py-0.5 rounded bg-amber-400/20 text-amber-400 shrink-0">
                {runningJobs.length}/{cap} running
              </span>
              {groupPending > 0 && (
                <span className="text-fg-faint">+{groupPending} ready in this group</span>
              )}
            </div>
          )
        })()}

        {/* Filter bar — List mode; Graph mode renders the status chips flat inside the counts strip. */}
        {isList && jobs.length > 0 && (
          <div className={gutter}>
            <FilterBar
              showText={filterText === undefined}
              filter={filter}
              onChange={(f) => { setFilter(f); saveFilter(f) }}
            />
          </div>
        )}

        {/* Graph mode (2A): full-bleed plan bands — one per Epic — of stage columns. */}
        {!isList && (
          <div data-testid="plan-graph">
            {/* The old second toolbar row (counts / status chips / Clear completed / Archive) is gone in Graph mode:
                its contents live in the PLANS toolbar via this portal. List mode deliberately KEEPS its own
                counts header (below) — the asymmetry is intentional, not an oversight. */}
            {planToolsEl && createPortal(
              <PlanTools
                jobCount={filteredJobs.length}
                counts={counts}
                filter={filter}
                onFilter={(f) => { setFilter(f); saveFilter(f) }}
                hiddenInGraph={hiddenInGraph}
                onUnhideAll={onUnhideAll}
                hasInlineCompleted={hasInlineCompleted}
                onClearCompleted={onClearCompleted}
                onClearQueue={onClearQueue}
                clearQueueDisabled={jobs.every((j) => j.status === 'running')}
              />,
              planToolsEl,
            )}
            {plans.length === 0 && (
              <div className="px-[18px] py-6 text-[13px] text-fg-faint italic">no matching jobs</div>
            )}
            <div ref={jobListRef} role="list" aria-label="Job queue" onKeyDown={handleJobListKeyDown}>
              {plans.map((plan) => (
                <PlanBand
                  key={plan.epicId ?? '__none__'}
                  plan={plan}
                  mode={planMode}
                  now={now}
                  hidden={graphHidden}
                  indexBySlug={indexBySlug}
                  headChoicesBySlug={headChoicesBySlug}
                  onRowFocused={handleRowFocused}
                  onOpenPrds={onOpenPrds}
                />
              ))}
            </div>
          </div>
        )}

        {/* Job table — List mode (the pre-2A vertical tree, unchanged) */}
        {isList && <div className="bg-bg-hi border border-line rounded-2xl overflow-hidden">
          {/* Table header */}
          <div className="flex items-center justify-between px-[18px] py-3 bg-bg-elev">
            <span className="font-serif text-base font-semibold text-fg">
              {filteredJobs.length} job{filteredJobs.length !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[12px] text-fg-faint">
                {counts.pending}p · {counts.running}r · {counts.completed}d
                {counts.failed > 0 && <span className="text-accent"> · {counts.failed}f</span>}
              </span>
              {hasInlineCompleted && (
                <button
                  type="button"
                  onClick={onClearCompleted}
                  className="text-[12.5px] text-fg-dim hover:text-fg bg-transparent border-0 cursor-pointer font-medium"
                  title="Hide completed jobs from this view (queue.json unchanged — they remain in history)"
                >
                  Clear completed
                </button>
              )}
              <button
                type="button"
                onClick={onClearQueue}
                disabled={jobs.every((j) => j.status === 'running')}
                className="text-[12px] text-accent border border-accent/40 hover:bg-accent/10 rounded-md px-2.5 py-1 cursor-pointer font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                title="Archive every non-running PRD (moved to prds-archived/<timestamp>/) and remove them from the queue. Running jobs are kept."
              >
                Archive &amp; clear queue…
              </button>
            </div>
          </div>

          {inline.length === 0 && collapsedCount === 0 && (
            <div className="px-[18px] py-6 text-[13px] text-fg-faint italic">no matching jobs</div>
          )}

          {/* Job rows — grouped by Epic, nested by dependsOn chain (see
             lib/backlogTree). `visibleSlugSet` applies the existing text/
             status filter and completed-collapse on top of the always-
             complete tree, so blocker/cycle resolution stays correct even
             for a slug the current filter hides. */}
          <div
            ref={jobListRef}
            role="list"
            aria-label="Job queue"
            onKeyDown={handleJobListKeyDown}
          >
            {(() => {
              const visibleSlugSet = new Set(inline.map((j) => j.slug))
              let runningIdx = 0
              // Each Epic section can contain MULTIPLE independent heads
              // (section.nodes' top-level roots) — a plan that got a
              // 'new-head' disposition instead of extending the prior chain.
              // Rendered as one continuous list before this PRD, with no
              // boundary between them, a human couldn't tell a two-head Epic
              // from one long chain. Iterating heads individually (instead of
              // flattening the whole section at once) makes that boundary
              // visible and gives each head's rows the sibling heads' current
              // terminal PRDs to offer as "attach behind" targets.
              const sectionBlocks = backlogSections
                .map((section) => {
                  const headChoices = sectionHeadChoices(section)
                  const heads = section.nodes
                    .map((headNode) => {
                      const rows = flattenBacklogNodes([headNode])
                        .filter((n) => visibleSlugSet.has(n.row.slug))
                        .map((node) => ({ node, listIndex: runningIdx++ }))
                      return { headRootSlug: headNode.row.slug, rows }
                    })
                    .filter((h) => h.rows.length > 0)
                  return { section, heads, headChoices }
                })
                .filter((b) => b.heads.length > 0)
              return sectionBlocks.map(({ section, heads, headChoices }) => (
                <EpicSectionBlock key={section.epicId ?? '__none__'} section={section}>
                  {heads.map(({ headRootSlug, rows }, headIdx) => (
                    <div key={headRootSlug} data-testid="backlog-head-group">
                      {heads.length > 1 && (
                        <div
                          className="px-[18px] pt-2.5 pb-1 text-[11px] font-mono uppercase tracking-wide text-fg-faint bg-bg-elev/30 border-t border-line/60"
                          data-testid="backlog-head-label"
                        >
                          Plan {headIdx + 1} of {heads.length}
                        </div>
                      )}
                      {rows.map(({ node, listIndex }) => (
                        <JobRow
                          key={node.row.slug}
                          job={node.row}
                          backlog={node}
                          eta={etaMap.get(node.row.slug) ?? null}
                          // Only running rows tick — everyone else gets a stable
                          // `null` across ticks, so JobRow's memo bails for them
                          // instead of re-rendering once a second for an unused
                          // `now` value.
                          elapsedMs={node.row.status === 'running' && node.row.startedAt ? now - Date.parse(node.row.startedAt) : null}
                          avgDurationMs={avgDurationMs}
                          listIndex={listIndex}
                          hold={holdBySlug.get(node.row.slug)}
                          onFocused={handleRowFocused}
                          headChoices={headChoices.filter((h) => h.rootSlug !== headRootSlug)}
                        />
                      ))}
                    </div>
                  ))}
                </EpicSectionBlock>
              ))
            })()}
          </div>

          {/* Collapse toggle */}
          {collapsedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllCompleted((v) => !v)}
              className="w-full text-left text-[12px] text-fg-faint hover:text-fg-dim px-[18px] py-3 border-t border-line"
              title={showAllCompleted ? 'Re-collapse old/cleared completed' : 'Show all completed (incl. cleared and >24h)'}
            >
              {showAllCompleted ? '▾' : '▸'} {collapsedCount} more completed
              <span className="ml-1.5 font-mono text-[11.5px] text-fg-faint">
                · fresh &amp; capped at 5 shown inline
              </span>
              {hiddenSlugs.size > 0 && (
                <span
                  className="ml-2 underline"
                  onClick={(e) => { e.stopPropagation(); onUnhideAll() }}
                >
                  un-hide
                </span>
              )}
            </button>
          )}
        </div>}

        {/* Coach — reassurance that nothing is needed while things run automatically */}
        {isList && !paused && (
          <div className={gutter}><div className="flex gap-2.5 bg-sage/10 border border-sage/30 rounded-xl px-3.5 py-2.5 text-[13.5px] text-fg-dim leading-relaxed">
            <span aria-hidden="true">✓</span>
            <span>
              <strong className="font-semibold text-fg">Nothing needed from you.</strong>{' '}
              Close the app if you like — jobs keep running, and History shows how each one ended.
            </span>
          </div></div>
        )}
      </div>

      {/* Footer diagnostics band — full-bleed (replaces DiagnosticsSection + the old footer row) */}
      <SchedulerFooter health={health} jobCount={jobs.length} lastRunAt={lastRunAt} nextReset={nextReset} now={now} onOpenSupervisor={() => setPanelView('supervisor')} />
    </div>
  )
}

/** O(N log N) once: for each job, count of running+pending jobs ahead of it,
 *  ordered by unmet-`dependsOn`-count then slug — `dependsOn` is the real
 *  ordering primitive (`parallelGroup` is a display hint, never a barrier;
 *  see CLAUDE.md's Avoid list), so a row waiting on more unmet blockers
 *  reads as further back in line. Lets computeEtaMap be O(1) per job. */
function computeAheadCounts(jobs: ScheduleJob[]): Map<string, number> {
  const bySlug = new Map(jobs.map((j) => [j.slug, j]))
  const unmetDepCount = (j: ScheduleJob) =>
    (j.dependsOn ?? []).filter((d) => bySlug.get(d)?.status !== 'completed').length
  const active = jobs
    .filter((j) => j.status === 'running' || j.status === 'pending')
    .sort((a, b) => unmetDepCount(a) - unmetDepCount(b) || a.slug.localeCompare(b.slug))
  const out = new Map<string, number>()
  active.forEach((j, i) => out.set(j.slug, i))
  return out
}

/** Split jobs into inline-visible and "rolled up into a +N more line".
 *  Rules:
 *  - pending / running / failed: always inline (actionable).
 *  - completed: inline only if NOT user-hidden AND fresh (<24h) AND under cap (5).
 *  - showAllCompleted overrides everything → all jobs inline. */
function partitionJobs(
  jobs: ScheduleJob[],
  hiddenSlugs: Set<string>,
  now: number,
  showAll: boolean,
): { inline: ScheduleJob[]; collapsedCount: number } {
  if (showAll) return { inline: jobs, collapsedCount: 0 }
  const completedByFreshness = jobs
    .filter((j) => j.status === 'completed')
    .sort((a, b) => {
      const at = a.finishedAt ? Date.parse(a.finishedAt) : 0
      const bt = b.finishedAt ? Date.parse(b.finishedAt) : 0
      return bt - at
    })
  const keepCompleted = new Set<string>()
  let kept = 0
  for (const j of completedByFreshness) {
    if (kept >= COMPLETED_DISPLAY_CAP) break
    if (hiddenSlugs.has(j.slug)) continue
    if (j.finishedAt && now - Date.parse(j.finishedAt) > COMPLETED_FRESH_MS) continue
    keepCompleted.add(j.slug)
    kept++
  }
  const inline: ScheduleJob[] = []
  let collapsedCount = 0
  for (const j of jobs) {
    if (j.status === 'failed' && hiddenSlugs.has(j.slug)) { collapsedCount++; continue }
    if (j.status !== 'completed') { inline.push(j); continue }
    if (keepCompleted.has(j.slug)) inline.push(j)
    else collapsedCount++
  }
  return { inline, collapsedCount }
}

/** Per-job ETA for every row in `jobsToShow`, computed once per tick in one
 *  pass instead of once per row inline inside a JSX .map — also finds the
 *  currently-running job a single time and reuses its elapsed time, instead
 *  of re-scanning `allJobs` with `.find(...)` from scratch per pending row.
 *  O(1) per job given the pre-computed `aheadIndex` from computeAheadCounts.
 *  Approximates serial execution within group at the rolling-avg duration. */
function computeEtaMap(
  jobsToShow: ScheduleJob[],
  allJobs: ScheduleJob[],
  aheadIndex: Map<string, number>,
  avgDurationMs: number,
  statusKind: StatusKind,
  now: number,
): Map<string, string | null> {
  const m = new Map<string, string | null>()
  if (statusKind === 'paused' || statusKind === 'manual' || statusKind === 'auto-throttled') {
    for (const j of jobsToShow) m.set(j.slug, null)
    return m
  }
  const running = allJobs.find((j) => j.status === 'running' && j.startedAt)
  const runningElapsedMs = running?.startedAt ? now - Date.parse(running.startedAt) : 0
  for (const j of jobsToShow) {
    if (j.status !== 'pending') { m.set(j.slug, null); continue }
    const aheadIdx = aheadIndex.get(j.slug) ?? 0
    let estMs = aheadIdx * avgDurationMs
    if (aheadIdx > 0) estMs -= Math.min(avgDurationMs, runningElapsedMs)
    m.set(j.slug, estMs <= 5_000 ? '~now' : `~${formatTimingLabel(estMs)}`)
  }
  return m
}


// ─── Filter bar ─────────────────────────────────────────────────────────────

const FILTER_CHIPS: Array<{ label: string; value: FilterStatus }> = [
  { label: 'All', value: 'all' },
  { label: 'Running', value: 'running' },
  { label: 'Investigating', value: 'investigating' },
  { label: 'Pending', value: 'pending' },
  { label: 'Completed', value: 'completed' },
  { label: 'Skipped', value: 'skipped' },
  { label: 'Needs review', value: 'needs_review' },
  { label: 'Failed', value: 'failed' },
  { label: 'Quarantined', value: 'quarantined' },
]

/**
 * Graph-mode job counts + status filter + overflow menu, rendered INTO the PLANS toolbar (see the
 * planToolsEl portal). Status filter = a compact select beside the toolbar's text filter; Clear
 * completed / Archive & clear queue… sit behind a click-opened ⋯ menu (Escape / outside click closes).
 */
function PlanTools({ jobCount, counts, filter, onFilter, hiddenInGraph, onUnhideAll, hasInlineCompleted, onClearCompleted, onClearQueue, clearQueueDisabled }: {
  jobCount: number
  counts: { pending: number; running: number; completed: number; failed: number }
  filter: QueueFilter
  onFilter: (f: QueueFilter) => void
  hiddenInGraph: number
  onUnhideAll: () => void
  hasInlineCompleted: boolean
  onClearCompleted: () => void
  onClearQueue: () => void
  clearQueueDisabled: boolean
}) {
  const item = 'block w-full text-left px-2 py-1 text-[12px] hover:bg-bg-hi disabled:opacity-40 disabled:cursor-not-allowed bg-transparent border-0 cursor-pointer'
  return (
    <>
      <span className="font-mono text-[11.5px] text-fg-faint whitespace-nowrap" data-testid="plan-tools-counts">
        {jobCount} job{jobCount !== 1 ? 's' : ''} · {counts.pending}p · {counts.running}r · {counts.completed}d
        {counts.failed > 0 && <span className="text-accent"> · {counts.failed}f</span>}
      </span>
      {hiddenInGraph > 0 && (
        <button
          type="button"
          onClick={onUnhideAll}
          className="text-[12px] text-fg-faint hover:text-fg-dim underline bg-transparent border-0 cursor-pointer whitespace-nowrap"
          title="Show the completed/failed jobs hidden by Clear completed"
        >
          {hiddenInGraph} hidden · un-hide
        </button>
      )}
      <select
        data-testid="scheduler-status-filter"
        aria-label="Filter by status"
        value={filter.status}
        onChange={(e) => onFilter({ ...filter, status: e.target.value as FilterStatus })}
        className="bg-bg-hi border border-line rounded px-1 py-0.5 text-[12px] text-fg-dim"
        title="Filter the plan graph by job status"
      >
        {FILTER_CHIPS.map((c) => <option key={c.value} value={c.value}>{c.value === 'all' ? 'all statuses' : c.label.toLowerCase()}</option>)}
      </select>
      <InfoDot title="Queue actions" testId="plan-tools-menu" popoverTestId="plan-tools-menu-popover" alignRight glyph="⋯" widthCls="w-52">
        <div className="-mx-3 -my-2">
          {hasInlineCompleted && (
            <button type="button" onClick={onClearCompleted} className={`${item} text-fg-dim`} title="Hide completed jobs from this view (queue.json unchanged — they remain in history)">
              Clear completed
            </button>
          )}
          <button
            type="button"
            onClick={onClearQueue}
            disabled={clearQueueDisabled}
            className={`${item} text-accent`}
            title="Archive every non-running PRD (moved to prds-archived/<timestamp>/) and remove them from the queue. Running jobs are kept."
          >
            Archive &amp; clear queue…
          </button>
        </div>
      </InfoDot>
    </>
  )
}

function FilterBar({ filter, onChange, showText }: { filter: QueueFilter; onChange: (f: QueueFilter) => void; showText: boolean }) {
  const chips = FILTER_CHIPS
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Text filter — hidden when the shell's PLANS toolbar owns it */}
      {showText && <div className="relative flex-1 min-w-[200px] max-w-[320px]">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint inline-flex" aria-hidden="true">
          <AlmanacIcon name="search" size={15} />
        </span>
        <input
          type="text"
          value={filter.text}
          onChange={(e) => onChange({ ...filter, text: e.target.value })}
          placeholder="filter jobs…"
          className="w-full bg-bg-hi border border-line rounded-xl py-2 pl-9 pr-3 text-[13.5px] text-fg placeholder:text-fg-faint focus:outline-none focus:border-fg-faint"
          aria-label="Filter jobs by title, slug, or project"
        />
      </div>}

      {/* Status chips */}
      <FilterPills options={chips} value={filter.status} onChange={(s) => onChange({ ...filter, status: s })} />
    </div>
  )
}

