import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScheduleStateSnapshot, ScheduleJob, ScheduleFirePolicy, ScheduleHealthSnapshot, SupervisorLogEntry, SupervisorConfig, LintQueueResult } from '../../preload/api.d'
import { toast } from '../state/toast'
import { formatTimingLabel, formatRelative, formatClock, formatAgo, formatDuration } from '../lib/formatTime'
import { useScheduleState } from '../state/scheduleState'
import { usePromptSessions } from '../state/promptSessions'
import { setPendingPromptSessionId } from '../lib/promptSessionDeepLink'
import { getLintQueueCached } from '../lib/lintQueueCache'
import { RunLogViewer } from './tabs/plans/RunLogViewer'
import { FilterPills } from './ui/FilterPills'
import { AlmanacIcon } from './layout/AlmanacIcon'
import { SchBadge, ProjectTag, EpicTag, DetailBlock, DetailLine, prdNumber, PrdNumberBadge, projectNameFromCwd, verdictLabel } from './tabs/scheduler/sched-primitives'
import { resolveEpicRef } from '../lib/epicProvenance'

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

/** Truncates a job row's linked-prompt-session label to keep the collapsed
 *  row a single line. */
function truncateLabel(text: string, max = 60): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

type FilterStatus = 'all' | 'running' | 'investigating' | 'pending' | 'completed' | 'needs_review' | 'failed'
interface QueueFilter { text: string; status: FilterStatus }

const FILTER_STATUS_VALUES: FilterStatus[] = ['all', 'running', 'investigating', 'pending', 'completed', 'needs_review', 'failed']

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
export function SchedulePanel({ scopeCwd = null }: { scopeCwd?: string | null }) {
  const rawSnap = useScheduleState((s) => s.snapshot)
  // Scheduler-as-browser (2026-07-31 domain model): the panel shows one
  // TAB/project's jobs when scoped. Derived AFTER selection (memoized) — never
  // build values inside a zustand selector (React #185 blank-app class).
  const snap = useMemo(() => {
    if (!rawSnap || !scopeCwd) return rawSnap
    return { ...rawSnap, jobs: rawSnap.jobs.filter((j) => j.cwd === scopeCwd) }
  }, [rawSnap, scopeCwd])
  const [health, setHealth] = useState<ScheduleHealthSnapshot | null>(null)
  const [showHealth, setShowHealth] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [hiddenSlugs, setHiddenSlugs] = useState<Set<string>>(() => loadHidden())
  const [showAllCompleted, setShowAllCompleted] = useState(false)
  const [filter, setFilter] = useState<QueueFilter>(() => loadFilter())
  const [meterBannerDismissed, setMeterBannerDismissed] = useState(false)
  const [panelView, setPanelView] = useState<'queue' | 'supervisor'>('queue')

  const jobListRef = useRef<HTMLDivElement>(null)
  const [focusedJobIdx, setFocusedJobIdx] = useState(() => {
    try { return Number(localStorage.getItem(FOCUSED_IDX_KEY)) || 0 } catch { return 0 }
  })

  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    window.api.schedule.health().then(setHealth).catch(() => {})
    const off = window.api.schedule.onState(() => {
      window.api.schedule.health().then(setHealth).catch(() => {})
    })
    return off
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

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

  // Hooks must run unconditionally on every render — declared here, before the
  // panelView/snap early returns below, so switching to the supervisor
  // sub-panel doesn't change the hook count between renders (React error #300:
  // "Rendered fewer hooks than expected").
  const handleJobListKeyDown = useCallback((e: React.KeyboardEvent) => {
    const rows = jobListRef.current?.querySelectorAll<HTMLButtonElement>('[data-job-row]')
    if (!rows || rows.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.min(focusedJobIdx + 1, rows.length - 1)
      setFocusedJobIdx(next)
      try { localStorage.setItem(FOCUSED_IDX_KEY, String(next)) } catch { /* */ }
      rows[next]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = Math.max(focusedJobIdx - 1, 0)
      setFocusedJobIdx(prev)
      try { localStorage.setItem(FOCUSED_IDX_KEY, String(prev)) } catch { /* */ }
      rows[prev]?.focus()
    }
  }, [focusedJobIdx])

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

  const { config, jobs, paused, lastRunAt, nextReset, effectiveConcurrency } = snap
  const counts = { pending: 0, running: 0, investigating: 0, completed: 0, needs_review: 0, failed: 0 }
  for (const j of jobs) {
    if (j.status in counts) counts[j.status as keyof typeof counts]++
  }

  const runningJobs = jobs.filter((j) => j.status === 'running')
  const status = computeStatus({ snap, now, avgDurationMs, runningJobs })

  const filteredJobs = applyFilter(jobs, filter)

  const aheadCount = computeAheadCounts(filteredJobs)

  const { inline, collapsedCount } = partitionJobs(filteredJobs, hiddenSlugs, now, showAllCompleted)

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
  const hasInlineCompleted = inline.some((j) => j.status === 'completed')

  return (
    <div className="overflow-y-auto h-full">
      {/* Screen-reader live region */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</div>

      <div className="px-9 py-6 max-w-[1100px] mx-auto space-y-4">

        {/* Status banner — FireStatus card */}
        <div
          className={`flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl border ${statusBannerClassAlmanac(status.kind)}`}
          title={status.tooltip}
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-[38px] h-[38px] rounded-xl bg-bg border border-line flex items-center justify-center shrink-0 ${statusToneClass(status.kind)}`}>
              <AlmanacIcon name="clock" size={19} />
            </div>
            <div className="min-w-0">
              <div className="text-[14px] text-fg truncate">{renderStatusLine1(withUtilization(status.line1, snap.utilization))}</div>
              {status.line2 && (
                <div className="text-[12px] text-fg-faint font-mono mt-0.5 truncate">{status.line2}</div>
              )}
            </div>
          </div>
          <span className="ml-auto font-mono text-[11.5px] text-fg-faint whitespace-nowrap">
            {config.concurrencyCap ?? 4} slot{(config.concurrencyCap ?? 4) !== 1 ? 's' : ''} · last batch {formatAgo(lastRunAt ? Date.parse(lastRunAt) : null, now)}
          </span>
          {status.action && (
            <button
              type="button"
              onClick={status.action.onClick}
              className="text-[12px] px-3 py-1.5 border border-line hover:border-fg-faint rounded-lg shrink-0 hover:bg-bg-hi text-fg-dim hover:text-fg"
              title={status.action.title}
            >
              {status.action.label}
            </button>
          )}
        </div>

        {/* Meter rate-limited banner */}
        {health && health.consecutiveFailures > 5 && health.lastFailureKind === 'meter_rate_limited' && !paused && !meterBannerDismissed && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-amber-400/15 border border-amber-400/30 rounded-xl">
            <span className="text-[12.5px] text-amber-400 font-medium">Meter rate-limited — firing on heuristic</span>
            <button
              type="button"
              onClick={() => setMeterBannerDismissed(true)}
              className="text-[12px] text-amber-400/70 hover:text-amber-400 shrink-0"
              title="Dismiss this banner. The scheduler continues firing normally."
            >
              Dismiss
            </button>
          </div>
        )}

        {/* PolicyBar */}
        <div className="flex items-center gap-[18px] flex-wrap bg-bg-elev border border-line rounded-xl px-4 py-3">
          {/* Start jobs */}
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-fg-dim">Start jobs</span>
            <select
              value={config.firePolicy ?? 'when-available'}
              onChange={(e) => window.api.schedule.setConfig({ firePolicy: e.target.value as ScheduleFirePolicy })}
              className="appearance-none border border-line bg-bg-hi rounded-lg px-2.5 py-1.5 font-sans text-[13px] text-fg font-medium"
              title="when-available: poll usage and fire when tokens are below threshold. on-reset: fire after each 5h reset. manual: only on Run now."
            >
              <option value="when-available">when available</option>
              <option value="on-reset">only on reset</option>
              <option value="manual">manually</option>
            </select>
          </div>

          {/* Concurrency cap */}
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-fg-dim">Up to</span>
            {effectiveConcurrency?.source === 'env' && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wide text-amber-400/90 bg-amber-400/10 border border-amber-400/30 rounded px-1.5 py-0.5"
                title="Pinned by SM_SCHEDULER_MAX_CONCURRENCY — unset the env var to edit"
              >
                env
              </span>
            )}
            <input
              type="number"
              min={1}
              max={20}
              value={effectiveConcurrency?.source === 'env' ? effectiveConcurrency.cap : config.concurrencyCap}
              disabled={effectiveConcurrency?.source === 'env'}
              onChange={(e) => window.api.schedule.setConfig({ concurrencyCap: Number(e.target.value) })}
              className="w-11 text-center border border-line bg-bg-hi rounded-lg py-1.5 font-mono text-[13px] text-fg disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                effectiveConcurrency?.source === 'env'
                  ? 'pinned by SM_SCHEDULER_MAX_CONCURRENCY — unset the env var to edit'
                  : 'Max simultaneous jobs within a parallel group'
              }
            />
            <span className="text-[13px] text-fg-dim">at once</span>
          </div>

          {/* Utilization threshold — only relevant for when-available policy */}
          {(config.firePolicy ?? 'when-available') === 'when-available' && (
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-fg-dim">Pause above</span>
              <input
                type="number"
                min={0}
                max={100}
                value={config.utilizationThreshold ?? 90}
                onChange={(e) => window.api.schedule.setConfig({ utilizationThreshold: Number(e.target.value) })}
                className="w-11 text-center border border-line bg-bg-hi rounded-lg py-1.5 font-mono text-[13px] text-fg"
                title="Fire only when 5h utilization is below this percent"
              />
              <span className="text-[13px] text-fg-dim">% of window</span>
            </div>
          )}

          {/* Actions */}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.api.schedule.forceTick().then(toast.fromOutcome).catch(() => toast.error('Failed to fire batch'))}
              disabled={counts.pending === 0 && counts.running === 0}
              className="bg-accent text-white rounded-lg px-4 py-2 text-[13px] font-semibold whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
              title="Bypasses the billing-usage poll. Use when the meter is rate-limited or you want immediate progress."
            >
              Fire next batch now
            </button>
            <button
              type="button"
              onClick={() => window.api.schedule.rescan().then(toast.fromOutcome).catch(() => toast.error('Failed to rescan'))}
              className="bg-bg-hi border border-line text-fg-dim hover:text-fg rounded-lg px-3.5 py-2 text-[13px] font-medium"
              title="Re-scan the prds/ folder. Use when you've added or edited PRDs on disk and want the queue to reflect them immediately."
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Running concurrency badge */}
        {runningJobs.length > 0 && (() => {
          const cap = config.concurrencyCap ?? 4
          const currentGroup = runningJobs[0]?.parallelGroup
          const groupPending = jobs.filter(
            (j) => j.status === 'pending' && j.parallelGroup === currentGroup
          ).length
          return (
            <div className="flex items-center gap-2 text-[12px] font-mono">
              <span className="px-2 py-0.5 rounded bg-amber-400/20 text-amber-400 shrink-0">
                {runningJobs.length}/{cap} running
              </span>
              {groupPending > 0 && (
                <span className="text-fg-faint">+{groupPending} ready in this group</span>
              )}
            </div>
          )
        })()}

        {/* Filter bar */}
        {jobs.length > 0 && (
          <FilterBar
            filter={filter}
            onChange={(f) => { setFilter(f); saveFilter(f) }}
          />
        )}

        {/* Job table */}
        <div className="bg-bg-hi border border-line rounded-2xl overflow-hidden">
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

          {/* Empty state */}
          {jobs.length === 0 && (
            <div className="px-[18px] py-6 text-[13px] text-fg-faint italic">
              No PRDs queued. Drop .md files in:
              <button
                type="button"
                onClick={() => window.api.schedule.openFolder()}
                className="block mt-1 text-fg-dim hover:text-fg underline truncate w-full text-left"
              >
                {'<project>/session-manager-operations/scheduler/prds/'}
              </button>
            </div>
          )}

          {jobs.length > 0 && inline.length === 0 && collapsedCount === 0 && (
            <div className="px-[18px] py-6 text-[13px] text-fg-faint italic">no matching jobs</div>
          )}

          {/* Job rows */}
          <div
            ref={jobListRef}
            role="list"
            aria-label="Job queue"
            onKeyDown={handleJobListKeyDown}
          >
            {inline.map((j, idx) => (
              <JobRow
                key={j.slug}
                job={j}
                eta={etaForJob(j, jobs, aheadCount.get(j.slug) ?? 0, avgDurationMs, status.kind, now)}
                now={now}
                avgDurationMs={avgDurationMs}
                listIndex={idx}
                onFocused={(i) => {
                  setFocusedJobIdx(i)
                  try { localStorage.setItem(FOCUSED_IDX_KEY, String(i)) } catch { /* */ }
                }}
              />
            ))}
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
        </div>

        {/* Bundle D — queue-health linter widget */}
        <QueueHealthSection snap={snap} />

        {/* Scheduler health disclosure */}
        <SchedulerHealthSection health={health} now={now} showHealth={showHealth} setShowHealth={setShowHealth} />

        {/* Footer */}
        <div className="flex items-center justify-between text-[12px] text-fg-faint pt-1 border-t border-line">
          <span>
            {nextReset && <span title={`next 5h reset: ${nextReset}`}>reset {formatRelative(Date.parse(nextReset) - now)}</span>}
            {lastRunAt && <span className="ml-2" title={lastRunAt}>last run {formatRelative(now - Date.parse(lastRunAt))} ago</span>}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPanelView('supervisor')}
              className="hover:text-fg-dim underline"
              title="Open supervisor log and settings"
            >
              supervisor
            </button>
            <button
              type="button"
              onClick={() => window.api.schedule.openFolder()}
              className="hover:text-fg-dim underline"
            >
              folder
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

type StatusKind = 'running' | 'paused' | 'auto-soon' | 'auto-throttled' | 'manual' | 'on-reset' | 'idle'

interface StatusInfo {
  kind: StatusKind
  line1: string
  line2: string | null
  tooltip?: string
  action?: { label: string; onClick: () => void; title: string }
}

function computeStatus({
  snap, now, avgDurationMs, runningJobs,
}: { snap: ScheduleStateSnapshot; now: number; avgDurationMs: number; runningJobs: ScheduleJob[] }): StatusInfo {
  const { config, jobs, paused, nextReset, utilization } = snap
  let pendingCount = 0
  let completedCount = 0
  for (const j of jobs) {
    if (j.status === 'pending') pendingCount++
    else if (j.status === 'completed') completedCount++
  }
  const runningCount = runningJobs.length
  const totalActive = pendingCount + runningCount
  const cap = config.concurrencyCap ?? 4

  if (runningCount > 0) {
    const oldest = runningJobs.reduce((a, b) =>
      (a.startedAt ?? '') < (b.startedAt ?? '') ? a : b
    )
    const elapsed = oldest.startedAt ? now - Date.parse(oldest.startedAt) : 0
    const k = completedCount + runningCount
    const n = completedCount + totalActive
    const concurrencyLabel = runningCount > 1 ? ` · ${runningCount}/${cap} parallel` : ''
    return {
      kind: 'running',
      line1: `Running ${k}/${n}${concurrencyLabel} · ${formatTimingLabel(elapsed)}`,
      line2: runningCount === 1
        ? oldest.title
        : runningJobs.map((j) => j.title).join(', '),
      tooltip: runningJobs.map((j) => `${j.slug} (g${j.parallelGroup})`).join('; '),
    }
  }

  if (paused) {
    const resumeMs = paused.resumeAt ? Date.parse(paused.resumeAt) - now : null
    const pauseLine1: Record<string, string> = {
      rate_limit: 'Paused — tokens exhausted',
      auth: 'Paused — authentication failed',
      network: 'Paused — network unreachable',
      reset_failure: 'Paused — billing data unavailable',
      manual: 'Paused — manual',
    }
    const pauseLine2Auth = 'Run `claude` in any terminal to refresh credentials, then Resume'
    return {
      kind: 'paused',
      line1: pauseLine1[paused.reason] ?? `Paused — ${paused.reason}`,
      line2: paused.reason === 'auth'
        ? pauseLine2Auth
        : resumeMs !== null && resumeMs > 0
          ? `auto-resume ${formatClock(Date.parse(paused.resumeAt!))} (in ${formatRelative(resumeMs)})`
          : (paused.resumeAt ? 'resuming…' : 'no auto-resume scheduled'),
      tooltip: paused.resumeAt ?? '',
      action: {
        label: 'Resume',
        onClick: () => window.api.schedule.resume(),
        title: 'Clear the pause and resume queue immediately',
      },
    }
  }

  if (totalActive === 0) {
    return { kind: 'idle', line1: 'No work queued', line2: null }
  }

  const pol = config.firePolicy ?? 'when-available'
  if (pol === 'manual') {
    return {
      kind: 'manual',
      line1: `Manual · ${pendingCount} pending`,
      line2: 'click Fire next batch now to fire',
      action: {
        label: 'Fire next batch now',
        onClick: () => window.api.schedule.forceTick().then(toast.fromOutcome).catch(() => toast.error('Failed to fire batch')),
        title: 'Bypasses the billing-usage poll. Use when the meter is rate-limited or you want immediate progress.',
      },
    }
  }

  if (pol === 'on-reset') {
    if (!nextReset) {
      return { kind: 'on-reset', line1: 'On-reset · waiting for billing data', line2: null }
    }
    const fireAt = Date.parse(nextReset) + (config.offsetMinutes * 60_000)
    const wait = fireAt - now
    return {
      kind: 'on-reset',
      line1: `On-reset · ${pendingCount} pending`,
      line2: wait > 0 ? `fires ${formatClock(fireAt)} (in ${formatRelative(wait)})` : 'firing now…',
    }
  }

  // when-available
  const thresh = config.utilizationThreshold ?? 90
  if (utilization === null || utilization === undefined) {
    return {
      kind: 'auto-soon',
      line1: `Auto · ${pendingCount} pending`,
      line2: 'checking token availability…',
    }
  }
  if (utilization >= thresh) {
    const wait = nextReset ? Date.parse(nextReset) - now : null
    return {
      kind: 'auto-throttled',
      line1: `Auto · throttled (util ${utilization.toFixed(0)}% ≥ ${thresh}%)`,
      line2: wait && wait > 0
        ? `next reset ${formatClock(Date.parse(nextReset!))} (in ${formatRelative(wait)})`
        : 'will fire when usage drops',
    }
  }
  return {
    kind: 'auto-soon',
    line1: `Auto · ${pendingCount} pending · util ${utilization.toFixed(0)}%`,
    line2: `fires within 2 min (poll cycle)`,
  }
}

/** O(N log N) once: for each job, count of running+pending jobs ahead of it
 *  in (parallelGroup, slug) order. Lets etaForJob be O(1). */
function computeAheadCounts(jobs: ScheduleJob[]): Map<string, number> {
  const active = jobs
    .filter((j) => j.status === 'running' || j.status === 'pending')
    .sort((a, b) => a.parallelGroup - b.parallelGroup || a.slug.localeCompare(b.slug))
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

function statusBannerClassAlmanac(kind: StatusKind): string {
  if (kind === 'running') return 'bg-amber-400/10 border-amber-400/25'
  if (kind === 'paused') return 'bg-amber-500/10 border-amber-500/25'
  if (kind === 'auto-throttled') return 'bg-amber-500/5 border-amber-500/15'
  return 'bg-bg-elev border-line'
}

/** FireStatus icon tone by status kind — mirrors the design's kind→tone mapping. */
function statusToneClass(kind: StatusKind): string {
  if (kind === 'running' || kind === 'auto-soon') return 'text-accent'
  if (kind === 'idle') return 'text-sage'
  if (kind === 'paused' || kind === 'auto-throttled') return 'text-butter'
  return 'text-fg-faint' // manual, on-reset
}

const STATUS_MODE_WORDS = ['Running', 'Paused', 'Manual', 'On-reset', 'Auto']

/** Bolds the leading mode token (Running/Paused/Manual/On-reset/Auto) in a status line1, if present. */
function renderStatusLine1(line1: string): ReactNode {
  for (const word of STATUS_MODE_WORDS) {
    if (line1.startsWith(word)) {
      return (
        <>
          <strong className="font-bold">{word}</strong>
          {line1.slice(word.length)}
        </>
      )
    }
  }
  return line1
}

/** Appends `· util N%` to a status line1 when utilization is known and not already present. */
function withUtilization(line1: string, utilization: number | null | undefined): string {
  if (utilization === null || utilization === undefined || line1.includes('util')) return line1
  return `${line1} · util ${Math.round(utilization)}%`
}

/** Per-job ETA. O(1) given pre-computed `aheadIndex` from computeAheadCounts.
 *  Approximates serial execution within group at the rolling-avg duration;
 *  subtracts elapsed time for the currently-running job (if any). */
function etaForJob(
  job: ScheduleJob,
  allJobs: ScheduleJob[],
  aheadIndex: number,
  avgDurationMs: number,
  statusKind: StatusKind,
  now: number,
): string | null {
  if (job.status !== 'pending') return null
  if (statusKind === 'paused' || statusKind === 'manual' || statusKind === 'auto-throttled') return null
  let estMs = aheadIndex * avgDurationMs
  if (aheadIndex > 0) {
    const running = allJobs.find((j) => j.status === 'running' && j.startedAt)
    if (running && running.startedAt) {
      estMs -= Math.min(avgDurationMs, now - Date.parse(running.startedAt))
    }
  }
  if (estMs <= 5_000) return '~now'
  return `~${formatTimingLabel(estMs)}`
}

export function JobRow({ job, eta, now, avgDurationMs, listIndex, onFocused }: {
  job: ScheduleJob
  eta: string | null
  now: number
  avgDurationMs: number
  listIndex: number
  onFocused: (index: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [showLog, setShowLog] = useState(false)

  // Traceability link back to the Epic this job's PRD belongs to. Resolution
  // order (epicId → sourcePromptId → sourceTabId) lives in
  // lib/epicProvenance so the PRDs and History views resolve identically —
  // this row used to key on sourceTabId alone, which silently mis-resolved
  // rows where the two fields disagree.
  const sessions = usePromptSessions((s) => s.sessions)
  const epicRef = useMemo(() => resolveEpicRef(job, sessions), [job, sessions])
  const linkedPromptSession = epicRef.known && epicRef.epicId ? sessions[epicRef.epicId] : null

  const navigateToPromptSession = useCallback((id: string) => {
    setPendingPromptSessionId(id)
    window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
  }, [])

  const isRunning = job.status === 'running'
  const isFailed = job.status === 'failed'

  let trailingLabel: string | null = null
  if (isRunning && job.startedAt) {
    trailingLabel = `${formatDuration(now - Date.parse(job.startedAt))} elapsed`
  } else if (job.status === 'completed' && job.startedAt && job.finishedAt) {
    trailingLabel = `took ${formatTimingLabel(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}`
  } else if (eta) {
    trailingLabel = eta
  }

  // Note shown in collapsed row below the title
  const errorText = job.error ?? null
  const note = isFailed && errorText
    ? errorText.split('\n')[0]
    : job.status === 'needs_review' && job.verifierVerdict
      ? verdictLabel(job.verifierVerdict)
      : null

  // Progress fraction for running jobs (capped at 0.99 so it never "completes")
  const progressPct = isRunning && job.startedAt
    ? Math.min(0.99, (now - Date.parse(job.startedAt)) / avgDurationMs)
    : 0

  return (
    <div
      role="listitem"
      className="border-t border-line"
    >
      <button
        type="button"
        data-job-row
        data-job-index={listIndex}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => onFocused(listIndex)}
        className={`w-full text-left grid grid-cols-[116px_1fr_auto_auto] items-center gap-4 px-[18px] py-3.5 hover:bg-bg/40 focus:outline-none focus:ring-1 focus:ring-accent focus:ring-inset ${open ? 'bg-bg-elev/40' : ''}`}
        aria-expanded={open}
        aria-label={`${prdNumber(job.slug) ? `PRD ${prdNumber(job.slug)}, ` : ''}${job.title}, ${job.status}${trailingLabel ? `, ${trailingLabel}` : ''}`}
        title={job.title}
      >
        <SchBadge status={job.status} />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 text-[14.5px] font-medium text-fg leading-snug">
            {prdNumber(job.slug) && <PrdNumberBadge n={prdNumber(job.slug)!} />}
            {job.title}
          </div>
          {note && (
            <div className={`text-[12.5px] mt-0.5 ${isFailed ? 'text-accent/80' : 'text-fg-faint'}`}>
              {note}
            </div>
          )}
          <EpicTag
            epicId={epicRef.epicId}
            label={epicRef.label ? truncateLabel(epicRef.label) : null}
            onOpen={navigateToPromptSession}
            testId="job-row-prompt-session-chip"
            className="mt-0.5"
          />
        </div>
        <ProjectTag cwd={job.cwd} />
        <span className="inline-flex items-center gap-2.5 font-mono text-xs text-fg-faint shrink-0">
          {trailingLabel}
          <span
            className={`text-fg-faint inline-flex transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            <AlmanacIcon name="chevron" size={14} />
          </span>
        </span>
      </button>

      {/* Thin progress bar for running jobs (only when collapsed) */}
      {isRunning && !open && (
        <div className="h-1 bg-line mx-[18px] mb-3 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-1000"
            style={{ width: `${Math.max(4, progressPct * 100)}%` }}
          />
        </div>
      )}

      {/* Expanded detail panel */}
      {open && (
        <div className="px-[18px] py-5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-5 bg-bg-elev/50 border-t border-line">
          <DetailBlock label="Status">
            <DetailLine k="result" v={job.exitCode !== null ? `exit ${job.exitCode}` : '—'} />
            <DetailLine k="state" v={job.status.replace(/_/g, ' ')} />
            {job.verifierVerdict && (
              <DetailLine k="verdict" v={verdictLabel(job.verifierVerdict)} />
            )}
            {errorText && (
              <DetailLine k="error" v={errorText.split('\n')[0]} wrap />
            )}
          </DetailBlock>

          <DetailBlock label="Timing">
            <DetailLine
              k="started"
              v={job.startedAt ? formatClock(Date.parse(job.startedAt)) : '—'}
            />
            <DetailLine
              k="finished"
              v={job.finishedAt ? formatClock(Date.parse(job.finishedAt)) : '—'}
            />
            <DetailLine
              k="duration"
              v={
                job.startedAt && job.finishedAt
                  ? formatTimingLabel(Date.parse(job.finishedAt) - Date.parse(job.startedAt))
                  : isRunning && job.startedAt
                    ? formatDuration(now - Date.parse(job.startedAt))
                    : '—'
              }
            />
          </DetailBlock>

          <DetailBlock label="Location">
            <DetailLine k="group" v={`${job.parallelGroup} · ${job.slug}`} />
            <DetailLine k="cwd" v={job.cwd ?? '—'} wrap />
            <DetailLine k="epic" v={epicRef.label ?? epicRef.epicId ?? '—'} wrap />
            <DetailLine k="epic id" v={epicRef.epicId ?? '—'} wrap />
            <DetailLine k="prompt id" v={job.sourcePromptId ?? '—'} wrap />
            <DetailLine k="source tab" v={job.sourceTabId ?? '—'} wrap />
          </DetailBlock>

          <DetailBlock label="Actions">
            <div className="flex flex-col gap-1.5 items-start">
              {linkedPromptSession && (
                <button
                  type="button"
                  data-testid="job-row-prompt-session-link"
                  title={linkedPromptSession.goalText}
                  onClick={() => navigateToPromptSession(linkedPromptSession.id)}
                  className="text-[13px] font-semibold text-accent hover:text-accent/80 bg-transparent border-0 cursor-pointer p-0"
                >
                  view epic →
                </button>
              )}
              {job.runId && (
                <button
                  type="button"
                  onClick={() => setShowLog(true)}
                  className="text-[13px] font-semibold text-fg-dim hover:text-fg bg-transparent border-0 cursor-pointer p-0"
                >
                  view log →
                </button>
              )}
              {job.status !== 'pending' && job.status !== 'running' && (
                <button
                  type="button"
                  onClick={() => window.api.schedule.resetJob(job.slug)}
                  className="text-[13px] font-semibold text-fg-dim hover:text-fg bg-transparent border-0 cursor-pointer p-0"
                >
                  reset to pending →
                </button>
              )}
            </div>
          </DetailBlock>
        </div>
      )}

      {showLog && job.runId && (
        <RunLogViewer
          runId={job.runId}
          slug={job.slug}
          title={job.title || job.slug}
          onClose={() => setShowLog(false)}
        />
      )}
    </div>
  )
}

// ─── Filter bar ─────────────────────────────────────────────────────────────

function FilterBar({ filter, onChange }: { filter: QueueFilter; onChange: (f: QueueFilter) => void }) {
  const chips: Array<{ label: string; value: FilterStatus }> = [
    { label: 'All', value: 'all' },
    { label: 'Running', value: 'running' },
    { label: 'Investigating', value: 'investigating' },
    { label: 'Pending', value: 'pending' },
    { label: 'Completed', value: 'completed' },
    { label: 'Needs review', value: 'needs_review' },
    { label: 'Failed', value: 'failed' },
  ]
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Text filter */}
      <div className="relative flex-1 min-w-[200px] max-w-[320px]">
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
      </div>

      {/* Status chips */}
      <FilterPills options={chips} value={filter.status} onChange={(s) => onChange({ ...filter, status: s })} />
    </div>
  )
}

// ─── Supervisor sub-panel ────────────────────────────────────────────────────

function SupervisorPanel({
  supervisorConfig,
  onSetConfig,
  onBack,
}: {
  supervisorConfig: SupervisorConfig | undefined
  onSetConfig: (partial: Partial<SupervisorConfig>) => void
  onBack: () => void
}) {
  const [log, setLog] = useState<SupervisorLogEntry[]>([])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    window.api.supervisor.getLog().then(setLog).catch(() => {})
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  const cfg: SupervisorConfig = {
    enabled: supervisorConfig?.enabled ?? true,
    intervalMinutes: supervisorConfig?.intervalMinutes ?? 15,
    maxConcurrentProbes: supervisorConfig?.maxConcurrentProbes ?? 2,
    probeStaleThresholdMinutes: supervisorConfig?.probeStaleThresholdMinutes ?? 10,
  }

  return (
    <div className="bg-bg-elev/60">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-line">
        <button
          type="button"
          onClick={onBack}
          className="text-[10px] text-fg-faint hover:text-fg-dim"
          title="Back to queue"
        >
          ← queue
        </button>
        <span className="text-[11px] font-medium text-fg-dim">Supervisor</span>
        <button
          type="button"
          onClick={() => window.api.supervisor.getLog().then(setLog).catch(() => {})}
          className="ml-auto text-[10px] text-fg-faint hover:text-fg-dim underline"
          title="Refresh log"
        >
          refresh
        </button>
      </div>

      {/* Config controls */}
      <div className="px-3 py-2 space-y-1.5 border-b border-line">
        <div className="text-[9px] text-fg-faint uppercase tracking-wider">Config</div>
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-fg-faint">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => onSetConfig({ enabled: e.target.checked })}
              className="cursor-pointer"
            />
            <span>enabled</span>
          </label>
          <label className="flex items-center gap-1" title="How often to check for wedged jobs (minutes)">
            <span>interval</span>
            <input
              type="number"
              min={5}
              max={60}
              value={cfg.intervalMinutes}
              onChange={(e) => onSetConfig({ intervalMinutes: Number(e.target.value) })}
              className="w-10 bg-bg border border-line rounded px-1 py-0.5 font-mono"
            />
            <span>min</span>
          </label>
          <label className="flex items-center gap-1" title="Max concurrent Opus probes per tick">
            <span>probes</span>
            <input
              type="number"
              min={1}
              max={5}
              value={cfg.maxConcurrentProbes}
              onChange={(e) => onSetConfig({ maxConcurrentProbes: Number(e.target.value) })}
              className="w-8 bg-bg border border-line rounded px-1 py-0.5 font-mono"
            />
          </label>
          <label className="flex items-center gap-1" title="Probe a job only if no JSONL event in this many minutes">
            <span>stale</span>
            <input
              type="number"
              min={5}
              max={30}
              value={cfg.probeStaleThresholdMinutes}
              onChange={(e) => onSetConfig({ probeStaleThresholdMinutes: Number(e.target.value) })}
              className="w-8 bg-bg border border-line rounded px-1 py-0.5 font-mono"
            />
            <span>min</span>
          </label>
        </div>
      </div>

      {/* Log table */}
      <div className="px-3 py-2">
        <div className="text-[9px] text-fg-faint uppercase tracking-wider mb-1">
          Recent probes (last {log.length})
        </div>
        {log.length === 0 ? (
          <div className="text-[10px] text-fg-faint italic">No probes yet.</div>
        ) : (
          <div className="space-y-0.5 max-h-64 overflow-y-auto">
            {log.map((entry, i) => (
              <SupervisorLogRow key={`${entry.ts}-${i}`} entry={entry} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SupervisorLogRow({ entry, now }: { entry: SupervisorLogEntry; now: number }) {
  const isAction = entry.action !== 'none'
  const ago = formatRelative(now - entry.ts)
  return (
    <div
      className={`text-[10px] px-1.5 py-1 rounded font-mono ${isAction ? 'bg-red-500/10 border border-red-500/20' : 'bg-bg/40'}`}
      title={entry.reason}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-fg-faint shrink-0">{ago} ago</span>
        <span className={`shrink-0 px-1 rounded ${entry.verdict === 'stuck' ? 'text-red-400 bg-red-500/10' : 'text-green-500/70'}`}>
          {entry.verdict}
        </span>
        <span className="truncate text-fg-dim">{entry.jobSlug}</span>
        {isAction && (
          <span className="shrink-0 text-red-400">{entry.action}{entry.targetPid ? ` pid=${entry.targetPid}` : ''}</span>
        )}
        {entry.costUsd !== null && (
          <span className="shrink-0 text-fg-faint">${entry.costUsd.toFixed(3)}</span>
        )}
      </div>
      <div className="text-fg-faint truncate mt-0.5">{entry.reason}</div>
    </div>
  )
}


function SchedulerHealthSection({
  health,
  now,
  showHealth,
  setShowHealth,
}: {
  health: ScheduleHealthSnapshot | null
  now: number
  showHealth: boolean
  setShowHealth: (v: boolean) => void
}) {
  if (!health) return null
  const hasIssue = health.consecutiveFailures > 0 || health.pauseReason !== null
  return (
    <div className="text-[9px] text-fg-faint border-t border-line pt-1">
      <button
        type="button"
        onClick={() => setShowHealth(!showHealth)}
        className={`flex items-center gap-1 hover:text-fg-dim w-full text-left ${hasIssue ? 'text-amber-400' : ''}`}
        title="Scheduler diagnostic info"
      >
        <span>{showHealth ? '▾' : '▸'}</span>
        <span>
          {hasIssue
            ? health.consecutiveFailures > 0
              ? `scheduler health · ${health.consecutiveFailures} failure${health.consecutiveFailures !== 1 ? 's' : ''}`
              : 'scheduler health · paused'
            : 'scheduler health'}
        </span>
      </button>
      {showHealth && (
        <div className="mt-1 space-y-0.5 font-mono pl-2">
          <div>booted: {formatAgo(health.bootedAt, now)}</div>
          <div>last poll: {formatAgo(health.lastPollAt, now)} · {health.lastPollOk ? 'ok' : 'failed'}</div>
          {health.consecutiveFailures > 0 && (
            <div className="text-amber-400">failures: {health.consecutiveFailures}</div>
          )}
          {health.backoffNextAt !== null && health.backoffNextAt > now && (
            <div>retry in: {formatRelative(health.backoffNextAt - now)}</div>
          )}
          {health.nextResetCached && (
            <div>cached reset: {formatClock(Date.parse(health.nextResetCached))}</div>
          )}
          {health.runningJobs.length > 0 && (
            <div>
              running: {health.runningJobs.map((j) => `${j.slug}(pid ${j.pid})`).join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Bundle D — queue-health linter widget ──────────────────────────────────

/**
 * QueueHealthSection — scans queued PRDs for anti-patterns (unbounded loops,
 * missing frontmatter, missing cwd, --no-verify, etc.). Auto-runs once on
 * mount and re-runs whenever the schedule:state broadcast comes in (i.e. the
 * scheduler has nudged the queue — PRDs may have been added/edited).
 *
 * When there are errors the panel is expanded by default so they're visible
 * without user interaction.
 */
function QueueHealthSection({ snap }: { snap: ScheduleStateSnapshot }) {
  const [report, setReport] = useState<LintQueueResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const signal = `${snap.jobs.length}:${snap.lastRunAt ?? ''}`
  useEffect(() => {
    let alive = true
    setLoading(true)
    getLintQueueCached()
      .then((r) => {
        if (!alive) return
        setReport(r)
        const hasErrors = r.reports.some((rep) => rep.findings.some((f) => f.severity === 'error'))
        if (hasErrors) setOpen(true)
      })
      .catch(() => { /* */ })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [signal])

  if (!report) {
    return (
      <div className="text-[9px] text-fg-faint border-t border-line pt-1">
        {loading ? 'queue health · scanning…' : 'queue health · idle'}
      </div>
    )
  }

  let errors = 0
  let warns = 0
  const flaggedPrds = report.reports.filter((r) => r.findings.length > 0)
  for (const r of flaggedPrds) {
    for (const f of r.findings) {
      if (f.severity === 'error') errors++
      else warns++
    }
  }

  const clean = errors === 0 && warns === 0
  const summaryClass = errors > 0 ? 'text-red-400' : warns > 0 ? 'text-amber-400' : ''

  return (
    <div className="text-[9px] text-fg-faint border-t border-line pt-1">
      <div className={`flex items-center gap-1 w-full ${summaryClass}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 hover:text-fg-dim flex-1 text-left"
          title="Static lint of queued PRDs for unbounded loops, missing frontmatter, etc."
          aria-expanded={open}
        >
          <span>{open ? '▾' : '▸'}</span>
          <span>
            {clean
              ? `queue health · all clear (${report.reports.length} scanned)`
              : `queue health · ${errors} error${errors === 1 ? '' : 's'}${warns > 0 ? `, ${warns} warn${warns === 1 ? '' : 's'}` : ''}`}
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            setLoading(true)
            getLintQueueCached({ fresh: true })
              .then(setReport)
              .catch(() => {})
              .finally(() => setLoading(false))
          }}
          className="ml-auto text-fg-faint hover:text-fg-dim underline"
          title="Re-run the lint now"
        >
          {loading ? '…' : 'rerun'}
        </button>
      </div>
      {open && !clean && (
        <div className="mt-1 space-y-1 max-h-48 overflow-y-auto pl-2">
          {flaggedPrds.map((r) => (
            <div key={r.slug} className="font-mono">
              <div className="text-fg-dim truncate" title={r.slug}>{r.slug}</div>
              {r.findings.map((f, i) => (
                <div
                  key={`${r.slug}-${i}`}
                  className={`pl-3 truncate ${f.severity === 'error' ? 'text-red-400/80' : 'text-amber-400/70'}`}
                  title={f.snippet}
                >
                  {f.severity === 'error' ? '✗' : '⚠'} L{f.line}: {f.snippet}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {open && clean && (
        <div className="mt-1 pl-2 text-green-400/70 font-mono">
          ✓ no issues in {report.reports.length} PRD{report.reports.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  )
}
