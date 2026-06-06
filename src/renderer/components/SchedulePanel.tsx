import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ScheduleStateSnapshot, ScheduleJob, ScheduleFirePolicy, ScheduleHealthSnapshot, SupervisorLogEntry, SupervisorConfig, LintQueueResult } from '../../preload/api.d'
import { toast } from '../state/toast'
import { formatTimingLabel, formatRelative, formatClock, formatAgo, formatDuration } from '../lib/formatTime'
import { useScheduleState } from '../state/scheduleState'
import { getLintQueueCached } from '../lib/lintQueueCache'
import { StatusBadge } from './ui/StatusBadge'
import type { JobStatus } from './ui/StatusBadge'
import { RunLogViewer } from './tabs/plans/RunLogViewer'

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

type FilterStatus = 'all' | 'running' | 'pending' | 'completed' | 'failed'
interface QueueFilter { text: string; status: FilterStatus }

const FILTER_STATUS_VALUES: FilterStatus[] = ['all', 'running', 'pending', 'completed', 'failed']

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
    const tag = projectTag(j.cwd) ?? ''
    return (
      j.title.toLowerCase().includes(q) ||
      j.slug.toLowerCase().includes(q) ||
      tag.toLowerCase().includes(q)
    )
  })
}

const VERDICT_LABELS: Record<string, string> = {
  halt: 'verifier halted',
  deps_unmet: 'dependencies unmet',
  transcript_errors: 'transcript had errors',
  verify_unavailable: 'verify unavailable',
  uncommitted_changes: 'uncommitted changes',
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

/** Map a cwd to a short, human-recognizable project tag. */
function projectTag(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const segs = cwd.replace(/\/+$/, '').split('/')
  return segs[segs.length - 1] || cwd
}

/**
 * SchedulePanel — sits in the LeftNav. Always shows what will happen next:
 *   ▶ Running k/n · 1m12s         (a job is executing)
 *   ⏸ Paused — tokens · resumes 4:21 PM (~2h 14m)   (auto-paused on rate-limit)
 *   ⏰ Auto · ~5m (util 42%)      (when-available, will fire soon)
 *   ⏰ Auto · waiting on tokens (util 94%)          (when-available, throttled)
 *   ✋ Manual — click Run now      (firePolicy=manual)
 *
 * State is owned by the main process (queue.json). We hydrate via
 * `schedule.state()` and listen for `schedule:state` broadcasts.
 */
export function SchedulePanel() {
  // Snapshot is owned by the singleton poller in state/scheduleState.ts
  // (started once in App.tsx). Health is panel-local — periodic refresh
  // best-effort, logger-only on failure.
  const snap = useScheduleState((s) => s.snapshot)
  const [health, setHealth] = useState<ScheduleHealthSnapshot | null>(null)
  const [showHealth, setShowHealth] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [hiddenSlugs, setHiddenSlugs] = useState<Set<string>>(() => loadHidden())
  const [showAllCompleted, setShowAllCompleted] = useState(false)
  const [filter, setFilter] = useState<QueueFilter>(() => loadFilter())
  const [meterBannerDismissed, setMeterBannerDismissed] = useState(false)
  const [panelView, setPanelView] = useState<'queue' | 'supervisor'>('queue')

  // Keyboard navigation state for the job list
  const jobListRef = useRef<HTMLDivElement>(null)
  const [focusedJobIdx, setFocusedJobIdx] = useState(() => {
    try { return Number(localStorage.getItem(FOCUSED_IDX_KEY)) || 0 } catch { return 0 }
  })

  // Screen-reader live region — updated whenever a job status changes
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

  // Rolling avg job duration from completed jobs (used for ETA estimates).
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

  // Announce status changes for screen readers
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

  const { config, jobs, paused, lastRunAt, nextReset } = snap
  const counts = { pending: 0, running: 0, completed: 0, failed: 0 }
  for (const j of jobs) {
    if (j.status === 'pending' || j.status === 'running' || j.status === 'completed' || j.status === 'failed') {
      counts[j.status]++
    }
  }

  const runningJobs = jobs.filter((j) => j.status === 'running')
  const status = computeStatus({ snap, now, avgDurationMs, runningJobs })

  // Apply text + status filter before partitioning so the "+N more" count
  // reflects the filtered set (PRD requirement).
  const filteredJobs = applyFilter(jobs, filter)

  // Pre-compute "ahead" cumulative counts per job in (group, slug) order so
  // etaForJob is O(1) instead of O(N) per call. Done once per render.
  const aheadCount = computeAheadCounts(filteredJobs)

  // Partition: inline visible jobs vs. completed-collapsed-into-rollup.
  const { inline, collapsedCount } = partitionJobs(filteredJobs, hiddenSlugs, now, showAllCompleted)

  const onClearCompleted = () => {
    // Hide both completed AND failed rows. Pre-2026-05-22 this only handled
    // completed, which meant a failed/red row had NO UI affordance to dismiss
    // (e.g. a stale auto-investigation fix-PRD whose file was archived but the
    // queue entry lingered). Failed jobs are still "done" from the user's
    // perspective; hiding them is no different from hiding green.
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

  // Keyboard navigation for the job list
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

  return (
    <div className="bg-bg-elev/60">
      {/* Screen-reader live region for status change announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>

      {/* Status banner — always visible, always actionable */}
      <div className={`px-3 py-2 ${statusBannerClass(status.kind)}`} title={status.tooltip}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon kind={status.kind} />
            <div className="text-[11px] font-medium truncate">{status.line1}</div>
          </div>
          {status.action && (
            <button
              type="button"
              onClick={status.action.onClick}
              className="text-[10px] px-1.5 py-0.5 border border-line hover:border-fg-faint rounded shrink-0 hover:bg-bg"
              title={status.action.title}
            >
              {status.action.label}
            </button>
          )}
        </div>
        {status.line2 && (
          <div className="text-[10px] text-fg-faint mt-0.5 truncate font-mono">{status.line2}</div>
        )}
      </div>

      {/* Meter rate-limited banner — shown when billing API is consistently 429-ing but queue is still firing */}
      {health && health.consecutiveFailures > 5 && health.lastFailureKind === 'meter_rate_limited' && !paused && !meterBannerDismissed && (
        <div className="px-3 py-1.5 bg-amber-400/15 border-t border-amber-400/30 flex items-center justify-between gap-2">
          <span className="text-[10px] text-amber-400 font-medium">Meter rate-limited — firing on heuristic</span>
          <button
            type="button"
            onClick={() => setMeterBannerDismissed(true)}
            className="text-[10px] text-amber-400/70 hover:text-amber-400 shrink-0"
            title="Dismiss this banner. The scheduler continues firing normally."
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="px-3 pb-3 pt-2 space-y-2 border-t border-line">
        {/* fire policy + concurrency */}
        <div className="flex items-center gap-2 text-[10px] text-fg-faint">
          <label className="flex items-center gap-1">
            <span>policy</span>
            <select
              value={config.firePolicy ?? 'when-available'}
              onChange={(e) => window.api.schedule.setConfig({ firePolicy: e.target.value as ScheduleFirePolicy })}
              className="bg-bg border border-line rounded px-1 py-0.5"
              title="when-available: poll usage and fire when tokens are below threshold. on-reset: fire after each 5h reset. manual: only on Run now."
            >
              <option value="when-available">when available</option>
              <option value="on-reset">on reset</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <label className="flex items-center gap-1" title="Max simultaneous jobs within a parallel group">
            <span>parallel</span>
            <input
              type="number"
              min={1}
              max={20}
              value={config.concurrencyCap}
              onChange={(e) => window.api.schedule.setConfig({ concurrencyCap: Number(e.target.value) })}
              className="w-10 bg-bg border border-line rounded px-1 py-0.5 font-mono"
            />
          </label>
          {config.firePolicy === 'when-available' && (
            <label className="flex items-center gap-1" title="Fire only when 5h utilization is below this percent">
              <span>util&lt;</span>
              <input
                type="number"
                min={0}
                max={100}
                value={config.utilizationThreshold ?? 90}
                onChange={(e) => window.api.schedule.setConfig({ utilizationThreshold: Number(e.target.value) })}
                className="w-10 bg-bg border border-line rounded px-1 py-0.5 font-mono"
              />
              <span>%</span>
            </label>
          )}
        </div>

        {/* manual run + queue counts */}
        <div className="flex items-center gap-2 text-[10px] text-fg-faint">
          <button
            type="button"
            onClick={() => window.api.schedule.forceTick()}
            disabled={counts.pending === 0 && counts.running === 0}
            className="px-2 py-0.5 text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Bypasses the billing-usage poll. Use when the meter is rate-limited or you want immediate progress."
          >
            Fire next batch now
          </button>
          <button
            type="button"
            onClick={() => window.api.schedule.rescan()}
            className="px-1.5 py-0.5 text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded"
            title="Re-scan the prds/ folder. Use when you've added or edited PRDs on disk and want the queue to reflect them immediately."
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onClearQueue}
            disabled={jobs.every((j) => j.status === 'running')}
            className="px-1.5 py-0.5 text-fg-dim hover:text-red-400 border border-line hover:border-red-400/60 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Archive every non-running PRD (moved to prds-archived/<timestamp>/) and remove them from the queue. Running jobs are kept."
          >
            Clear
          </button>
          <div className="flex-1 text-right font-mono">
            {counts.pending}p · {counts.running}r · {counts.completed}d
            {counts.failed > 0 && <span className="text-red-400"> · {counts.failed}f</span>}
          </div>
          {hasInlineCompleted && (
            <button
              type="button"
              onClick={onClearCompleted}
              className="px-1.5 py-0.5 text-fg-faint hover:text-fg-dim hover:border-fg-faint border border-line rounded"
              title="Hide completed jobs from this view (queue.json unchanged — they remain in history)"
            >
              Clear done
            </button>
          )}
        </div>

        {/* concurrency badge + group-backfill hint */}
        {runningJobs.length > 0 && (() => {
          const cap = config.concurrencyCap ?? 4
          const currentGroup = runningJobs[0]?.parallelGroup
          const groupPending = jobs.filter(
            (j) => j.status === 'pending' && j.parallelGroup === currentGroup
          ).length
          return (
            <div className="flex items-center gap-2 text-[10px] font-mono">
              <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-400 shrink-0">
                {runningJobs.length}/{cap} running
              </span>
              {groupPending > 0 && (
                <span className="text-fg-faint">
                  +{groupPending} ready in this group
                </span>
              )}
            </div>
          )
        })()}

        {/* Filter bar — hidden when the queue is empty */}
        {jobs.length > 0 && (
          <FilterBar
            filter={filter}
            onChange={(f) => { setFilter(f); saveFilter(f) }}
          />
        )}

        {/* job list — show pending first (with ETA), then running, then recent completed */}
        <div
          ref={jobListRef}
          role="list"
          aria-label="Job queue"
          className="space-y-0.5 max-h-72 overflow-y-auto"
          onKeyDown={handleJobListKeyDown}
        >
          {jobs.length === 0 && (
            <div className="text-[10px] text-fg-faint italic">
              No PRDs queued. Drop .md files in:
              <button
                type="button"
                onClick={() => window.api.schedule.openFolder()}
                className="block mt-1 text-fg-dim hover:text-fg underline truncate w-full text-left"
              >
                ~/.claude/session-manager/scheduled-plans/prds/
              </button>
            </div>
          )}
          {jobs.length > 0 && inline.length === 0 && collapsedCount === 0 && (
            <div className="text-[10px] text-fg-faint italic px-1.5 py-1">no matching jobs</div>
          )}
          {inline.map((j, idx) => (
            <JobRow
              key={j.slug}
              job={j}
              eta={etaForJob(j, jobs, aheadCount.get(j.slug) ?? 0, avgDurationMs, status.kind, now)}
              now={now}
              listIndex={idx}
            />
          ))}
          {collapsedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllCompleted((v) => !v)}
              className="w-full text-left text-[10px] text-fg-faint hover:text-fg-dim px-1.5 py-1"
              title={showAllCompleted ? 'Re-collapse old/cleared completed' : 'Show all completed (incl. cleared and >24h)'}
            >
              {showAllCompleted ? '▾' : '▸'} {collapsedCount} more completed
              {hiddenSlugs.size > 0 && (
                <span className="ml-2 underline" onClick={(e) => { e.stopPropagation(); onUnhideAll() }}>
                  un-hide
                </span>
              )}
            </button>
          )}
        </div>

        {/* Bundle D — queue-health linter widget */}
        <QueueHealthSection snap={snap} />

        {/* scheduler health disclosure */}
        <SchedulerHealthSection health={health} now={now} showHealth={showHealth} setShowHealth={setShowHealth} />

        {/* footer: links */}
        <div className="flex items-center justify-between text-[9px] text-fg-faint pt-1 border-t border-line">
          <span>
            {nextReset && <span title={`next 5h reset: ${nextReset}`}>reset {formatRelative(Date.parse(nextReset) - now)}</span>}
            {lastRunAt && <span className="ml-2" title={lastRunAt}>last run {formatRelative(now - Date.parse(lastRunAt))} ago</span>}
          </span>
          <div className="flex items-center gap-2">
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
        onClick: () => window.api.schedule.forceTick(),
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
    // Failed jobs are normally always inline (actionable), BUT if the user
    // explicitly hid one via "Clear done" we honor that intent. Use the
    // disclosure-all toggle to see them again.
    if (j.status === 'failed' && hiddenSlugs.has(j.slug)) { collapsedCount++; continue }
    if (j.status !== 'completed') { inline.push(j); continue }
    if (keepCompleted.has(j.slug)) inline.push(j)
    else collapsedCount++
  }
  return { inline, collapsedCount }
}

function StatusIcon({ kind }: { kind: StatusKind }) {
  if (kind === 'running') return <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
  if (kind === 'paused') return <span className="text-[11px] shrink-0" title="paused">⏸</span>
  if (kind === 'manual') return <span className="text-[11px] shrink-0" title="manual">✋</span>
  if (kind === 'on-reset' || kind === 'auto-soon') return <span className="text-[11px] shrink-0" title="auto">⏰</span>
  if (kind === 'auto-throttled') return <span className="text-[11px] shrink-0" title="throttled">⏳</span>
  return <span className="w-1.5 h-1.5 rounded-full bg-fg-faint/40 shrink-0" />
}

function statusBannerClass(kind: StatusKind): string {
  if (kind === 'running') return 'bg-amber-400/10'
  if (kind === 'paused') return 'bg-amber-500/10'
  if (kind === 'auto-throttled') return 'bg-amber-500/5'
  return ''
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

function JobRow({ job, eta, now, listIndex }: { job: ScheduleJob; eta: string | null; now: number; listIndex: number }) {
  const [open, setOpen] = useState(false)
  const [showLog, setShowLog] = useState(false)

  const isFailed = job.status === 'failed'

  let trailingLabel: string | null = null
  if (job.status === 'running' && job.startedAt) {
    trailingLabel = `${formatDuration(now - Date.parse(job.startedAt))} elapsed`
  } else if (job.status === 'completed' && job.startedAt && job.finishedAt) {
    trailingLabel = `took ${formatTimingLabel(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}`
  } else if (eta) {
    trailingLabel = eta
  }

  const errorText = job.error ?? null

  const tag = projectTag(job.cwd)

  return (
    <div
      role="listitem"
      className={`text-[11px] rounded ${isFailed ? 'bg-red-950/20 border-l-2 border-red-600/60' : ''}`}
    >
      <button
        type="button"
        data-job-row
        data-job-index={listIndex}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-1.5 py-1 hover:bg-bg-hi rounded text-left focus:outline-none focus:ring-1 focus:ring-accent"
        aria-expanded={open}
        aria-label={`${job.title}, ${job.status}${trailingLabel ? `, ${trailingLabel}` : ''}`}
        title={job.title}
      >
        <StatusBadge status={job.status as JobStatus} className="shrink-0" />
        <span className="truncate flex-1 text-fg-dim">{job.title}</span>
        {tag && (
          <span
            className="font-mono text-[10px] text-accent shrink-0 px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10"
            title={`Project: ${job.cwd}`}
          >
            {tag}
          </span>
        )}
        {trailingLabel && (
          <span className="font-mono text-[9px] text-fg-faint shrink-0">{trailingLabel}</span>
        )}
      </button>

      {/* 1-line inline error summary for failed rows */}
      {isFailed && !open && (errorText || job.exitCode !== null) && (
        <div className="px-3 pb-1.5 text-[10px] text-red-300/90 truncate overflow-hidden text-ellipsis">
          {errorText ? errorText.split('\n')[0] : `exit ${job.exitCode}`}
        </div>
      )}
      {/* 1-line inline verdict summary for needs_review rows */}
      {job.status === 'needs_review' && job.verifierVerdict && !open && (
        <div className="px-3 pb-1.5 text-[10px] text-orange-300/80 truncate overflow-hidden text-ellipsis">
          verifier: {VERDICT_LABELS[job.verifierVerdict] ?? job.verifierVerdict}
        </div>
      )}

      {open && (
        <div className="px-3 py-2 space-y-3 bg-bg/50 rounded text-[10px] text-fg-faint">
          {/* Status section */}
          <section>
            <div className="text-[9px] uppercase tracking-wider text-fg-faint/60 mb-1.5">Status</div>
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={job.status as JobStatus} />
              {job.exitCode !== null && (
                <span className={`font-mono ${job.exitCode === 0 ? 'text-green-400' : 'text-red-400'}`}>
                  exit {job.exitCode}
                </span>
              )}
              {job.verifierVerdict && (
                <span className="font-mono text-orange-300/90">
                  {VERDICT_LABELS[job.verifierVerdict] ?? job.verifierVerdict}
                </span>
              )}
            </div>
            {errorText && (
              <div className="mt-1.5 text-red-300/90 break-words">{errorText}</div>
            )}
          </section>

          {/* Timing section */}
          {(job.startedAt || job.finishedAt) && (
            <section>
              <div className="text-[9px] uppercase tracking-wider text-fg-faint/60 mb-1.5">Timing</div>
              <div className="font-mono space-y-0.5">
                {job.startedAt && (
                  <div>started: {formatClock(Date.parse(job.startedAt))}</div>
                )}
                {job.finishedAt && (
                  <div>finished: {formatClock(Date.parse(job.finishedAt))} · {formatAgo(Date.parse(job.finishedAt), now)}</div>
                )}
                {job.startedAt && job.finishedAt && (
                  <div>duration: took {formatTimingLabel(Date.parse(job.finishedAt) - Date.parse(job.startedAt))}</div>
                )}
                {job.status === 'running' && job.startedAt && (
                  <div>elapsed: {formatDuration(now - Date.parse(job.startedAt))}</div>
                )}
              </div>
            </section>
          )}

          {/* Location section */}
          <section>
            <div className="text-[9px] uppercase tracking-wider text-fg-faint/60 mb-1.5">Location</div>
            <div className="font-mono space-y-0.5">
              <div>group {job.parallelGroup} · {job.slug}</div>
              {job.cwd && <div className="truncate" title={job.cwd}>cwd: {job.cwd}</div>}
            </div>
          </section>

          {/* Actions section */}
          <section>
            <div className="text-[9px] uppercase tracking-wider text-fg-faint/60 mb-1.5">Actions</div>
            <div className="flex gap-3 flex-wrap">
              {job.status !== 'pending' && (
                <button
                  type="button"
                  onClick={() => window.api.schedule.resetJob(job.slug)}
                  className="text-fg-dim hover:text-fg underline"
                >
                  reset to pending
                </button>
              )}
              {job.runId && (
                <button
                  type="button"
                  onClick={() => setShowLog(true)}
                  className="text-fg-dim hover:text-fg underline"
                >
                  view log
                </button>
              )}
            </div>
          </section>
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
    { label: 'Pending', value: 'pending' },
    { label: 'Completed', value: 'completed' },
    { label: 'Failed', value: 'failed' },
  ]
  return (
    <div className="space-y-1">
      <input
        type="text"
        value={filter.text}
        onChange={(e) => onChange({ ...filter, text: e.target.value })}
        placeholder="filter jobs…"
        className="w-full bg-bg border border-line rounded px-2 py-0.5 text-[10px] text-fg-dim placeholder:text-fg-faint focus:outline-none focus:border-fg-faint"
        aria-label="Filter jobs by title, slug, or project"
      />
      <div className="flex items-center gap-1 flex-wrap">
        {chips.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange({ ...filter, status: c.value })}
            className={`px-1.5 py-0.5 text-[9px] rounded border ${
              filter.status === c.value
                ? 'bg-accent/20 text-accent border-accent/40'
                : 'text-fg-faint border-line hover:border-fg-faint hover:text-fg-dim'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
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
  // Auto-expand when there are errors; user can collapse manually.
  const [open, setOpen] = useState(false)

  const signal = `${snap.jobs.length}:${snap.lastRunAt ?? ''}`
  useEffect(() => {
    let alive = true
    setLoading(true)
    getLintQueueCached()
      .then((r) => {
        if (!alive) return
        setReport(r)
        // Auto-expand if errors found — make issues visible without manual drill-down
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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 hover:text-fg-dim w-full text-left ${summaryClass}`}
        title="Static lint of queued PRDs for unbounded loops, missing frontmatter, etc."
        aria-expanded={open}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>
          {clean
            ? `queue health · all clear (${report.reports.length} scanned)`
            : `queue health · ${errors} error${errors === 1 ? '' : 's'}${warns > 0 ? `, ${warns} warn${warns === 1 ? '' : 's'}` : ''}`}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
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
      </button>
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
