import { useEffect, useMemo, useState } from 'react'
import type { ScheduleStateSnapshot, ScheduleJob, ScheduleFirePolicy, ScheduleHealthSnapshot } from '../../preload/api.d'

/** Inline completed-jobs cap. Older / overflow get rolled into the
 *  "+N more completed" collapse line. */
const COMPLETED_DISPLAY_CAP = 5
/** Anything completed more than this ago is auto-collapsed (with the
 *  cap above as a secondary limit on fresh completions). */
const COMPLETED_FRESH_MS = 24 * 60 * 60 * 1000
/** localStorage key for the user's "Clear completed" visual hides. The
 *  underlying queue.json is unchanged — this is renderer-side only. */
const HIDDEN_KEY = 'sm.scheduler.hiddenCompletedSlugs'

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
  const [snap, setSnap] = useState<ScheduleStateSnapshot | null>(null)
  const [health, setHealth] = useState<ScheduleHealthSnapshot | null>(null)
  const [showHealth, setShowHealth] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [hiddenSlugs, setHiddenSlugs] = useState<Set<string>>(() => loadHidden())
  const [showAllCompleted, setShowAllCompleted] = useState(false)

  useEffect(() => {
    let off: (() => void) | null = null
    window.api.schedule.state().then(setSnap).catch(() => {})
    off = window.api.schedule.onState((s) => {
      setSnap(s)
      // Refresh health on every state broadcast so running-job list stays live.
      window.api.schedule.health().then(setHealth).catch(() => {})
    })
    window.api.schedule.health().then(setHealth).catch(() => {})
    return () => { if (off) off() }
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

  if (!snap) return null

  const { config, jobs, paused, lastRunAt, nextReset } = snap
  const counts = { pending: 0, running: 0, completed: 0, failed: 0 }
  for (const j of jobs) {
    if (j.status === 'pending' || j.status === 'running' || j.status === 'completed' || j.status === 'failed') {
      counts[j.status]++
    }
  }

  const status = computeStatus({ snap, now, avgDurationMs })

  // Pre-compute "ahead" cumulative counts per job in (group, slug) order so
  // etaForJob is O(1) instead of O(N) per call. Done once per render.
  const aheadCount = computeAheadCounts(jobs)

  // Partition: inline visible jobs vs. completed-collapsed-into-rollup.
  const { inline, collapsedCount } = partitionJobs(jobs, hiddenSlugs, now, showAllCompleted)

  const onClearCompleted = () => {
    const next = new Set(hiddenSlugs)
    for (const j of jobs) if (j.status === 'completed') next.add(j.slug)
    setHiddenSlugs(next)
    saveHidden(next)
  }
  const onUnhideAll = () => {
    setHiddenSlugs(new Set())
    saveHidden(new Set())
    setShowAllCompleted(false)
  }
  const hasInlineCompleted = inline.some((j) => j.status === 'completed')

  return (
    <div className="bg-bg-elev/60">
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
            onClick={() => window.api.schedule.runNow()}
            disabled={counts.pending === 0 && counts.running === 0}
            className="px-2 py-0.5 text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Execute all pending jobs now (clears any pause)"
          >
            Run now
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

        {/* job list — show pending first (with ETA), then running, then recent completed */}
        <div className="space-y-0.5 max-h-72 overflow-y-auto">
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
          {inline.map((j) => (
            <JobRow
              key={j.slug}
              job={j}
              eta={etaForJob(j, jobs, aheadCount.get(j.slug) ?? 0, avgDurationMs, status.kind, now)}
              now={now}
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

        {/* scheduler health disclosure */}
        <SchedulerHealthSection health={health} now={now} showHealth={showHealth} setShowHealth={setShowHealth} />

        {/* footer: links */}
        <div className="flex items-center justify-between text-[9px] text-fg-faint pt-1 border-t border-line">
          <span>
            {nextReset && <span title={`next 5h reset: ${nextReset}`}>reset {formatRelative(Date.parse(nextReset) - now)}</span>}
            {lastRunAt && <span className="ml-2" title={lastRunAt}>last run {formatRelative(now - Date.parse(lastRunAt))} ago</span>}
          </span>
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
  snap, now, avgDurationMs,
}: { snap: ScheduleStateSnapshot; now: number; avgDurationMs: number }): StatusInfo {
  const { config, jobs, paused, nextReset, utilization } = snap
  let pendingCount = 0
  let completedCount = 0
  let firstRunning: ScheduleJob | null = null
  for (const j of jobs) {
    if (j.status === 'pending') pendingCount++
    else if (j.status === 'completed') completedCount++
    else if (j.status === 'running' && !firstRunning) firstRunning = j
  }
  const runningCount = firstRunning ? 1 : 0
  const totalActive = pendingCount + runningCount

  if (firstRunning) {
    const r = firstRunning
    const elapsed = r.startedAt ? now - Date.parse(r.startedAt) : 0
    const k = completedCount + 1
    const n = completedCount + totalActive
    return {
      kind: 'running',
      line1: `Running ${k}/${n} · ${formatDuration(elapsed)}`,
      line2: r.title,
      tooltip: `${r.slug} (group ${r.parallelGroup})`,
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
      line2: 'click Run now to fire',
      action: {
        label: 'Run now',
        onClick: () => window.api.schedule.runNow(),
        title: 'Execute all pending jobs now',
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
    if (j.status !== 'completed') { inline.push(j); continue }
    if (keepCompleted.has(j.slug)) inline.push(j)
    else collapsedCount++
  }
  return { inline, collapsedCount }
}

function StatusIcon({ kind }: { kind: StatusKind }) {
  if (kind === 'running') return <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
  if (kind === 'paused') return <span className="text-[11px] shrink-0" title="paused">⏸</span>
  if (kind === 'manual') return <span className="text-[11px] shrink-0" title="manual">✋</span>
  if (kind === 'on-reset' || kind === 'auto-soon') return <span className="text-[11px] shrink-0" title="auto">⏰</span>
  if (kind === 'auto-throttled') return <span className="text-[11px] shrink-0" title="throttled">⏳</span>
  return <span className="w-1.5 h-1.5 rounded-full bg-fg-faint/40 shrink-0" />
}

function statusBannerClass(kind: StatusKind): string {
  if (kind === 'running') return 'bg-accent/5'
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
  return `~+${formatRelative(estMs)}`
}

function JobRow({ job, eta, now }: { job: ScheduleJob; eta: string | null; now: number }) {
  const [open, setOpen] = useState(false)
  const dot =
    job.status === 'running' ? 'bg-accent animate-pulse' :
    job.status === 'completed' ? 'bg-green-500' :
    job.status === 'failed' ? 'bg-red-400' :
    'bg-fg-faint/40'

  let trailing: string | null = null
  if (job.status === 'running' && job.startedAt) {
    trailing = formatDuration(now - Date.parse(job.startedAt))
  } else if (job.status === 'completed' && job.startedAt && job.finishedAt) {
    trailing = formatDuration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))
  } else if (eta) {
    trailing = eta
  }

  const tag = projectTag(job.cwd)

  return (
    <div className="text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-1.5 py-1 hover:bg-bg-hi rounded text-left"
        title={job.title}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className="truncate flex-1 text-fg-dim">{job.title}</span>
        {tag && (
          <span
            className="font-mono text-[9px] text-fg-faint shrink-0 px-1 rounded bg-bg/50"
            title={job.cwd ?? ''}
          >
            {tag}
          </span>
        )}
        {trailing && (
          <span className="font-mono text-[9px] text-fg-faint shrink-0">{trailing}</span>
        )}
      </button>
      {open && (
        <div className="px-3 py-1 text-[10px] text-fg-faint space-y-1 bg-bg/50 rounded">
          <div className="font-mono">g{job.parallelGroup} · {job.slug}</div>
          {job.cwd && <div className="font-mono truncate" title={job.cwd}>cwd: {job.cwd}</div>}
          {job.exitCode !== null && (
            <div className={job.exitCode === 0 ? 'text-green-500' : 'text-red-400'}>
              exit {job.exitCode}
            </div>
          )}
          {job.error && <div className="text-red-400 break-all">{job.error}</div>}
          <div className="flex gap-2 pt-1">
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
                onClick={async () => {
                  const r = await window.api.schedule.readLog(job.runId!, job.slug)
                  if (r.ok && r.text) {
                    const w = window.open('', '_blank')
                    if (w) {
                      w.document.body.innerText = r.text
                      w.document.title = `${job.slug} — ${job.runId}`
                    }
                  }
                }}
                className="text-fg-dim hover:text-fg underline"
              >
                view log
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${(s % 60).toString().padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`
}

function formatRelative(ms: number): string {
  if (ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

function formatAgo(ms: number | null, now: number): string {
  if (ms === null) return 'never'
  const diff = now - ms
  if (diff < 0) return 'soon'
  if (diff < 5_000) return 'just now'
  return `${formatRelative(diff)} ago`
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
