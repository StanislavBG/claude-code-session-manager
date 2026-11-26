import type { ScheduleStateSnapshot, ScheduleJob } from '../../../../preload/api.d'
import { toast } from '../../../state/toast'
import { formatTimingLabel, formatClock, formatRelative } from '../../../lib/formatTime'

export type StatusKind = 'running' | 'paused' | 'auto-soon' | 'auto-throttled' | 'manual' | 'idle'

// A utilization hold whose reset is further out than this is not a routine 5h pause.
const LONG_HOLD_MS = 5 * 60 * 60_000

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour', session: '5-hour', weekly_all: 'weekly', weekly: 'weekly',
}
function windowLabel(name: string): string {
  return WINDOW_LABELS[name] ?? name.replace(/_/g, ' ')
}

/** The one 'P% ≥ T%' hold text, shared by the Scheduler band and Home's cap control. */
export function formatUsageHoldDetail(hold: { percent: number; threshold: number }): string {
  return `${hold.percent.toFixed(0)}% ≥ ${hold.threshold}%`
}

interface StatusInfo {
  kind: StatusKind
  line1: string
  line2: string | null
  tooltip?: string
  action?: { label: string; onClick: () => void; title: string }
}

export function computeStatus({
  snap, now, avgDurationMs, runningJobs,
}: { snap: ScheduleStateSnapshot; now: number; avgDurationMs: number; runningJobs: ScheduleJob[] }): StatusInfo {
  const { config, jobs, paused, utilization, utilizationHold, effectiveConcurrency } = snap
  let pendingCount = 0
  let completedCount = 0
  for (const j of jobs) {
    if (j.status === 'pending') pendingCount++
    else if (j.status === 'completed') completedCount++
  }
  const runningCount = runningJobs.length
  const totalActive = pendingCount + runningCount
  const cap = effectiveConcurrency?.cap ?? 5

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
      manual: 'Paused — manual (you paused the queue)',
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

  // when-available. Throttled is read from the scheduler's own hold, never
  // re-derived from utilization >= threshold (that drifted from what dispatch did).
  if (utilizationHold) {
    const { percent, threshold, window: holdWindow, resetsAt } = utilizationHold
    const wait = resetsAt ? Date.parse(resetsAt) - now : null
    const win = holdWindow ? windowLabel(holdWindow) : null
    // Unknown reset horizon is treated as the LONG case, never the benign one.
    const long = wait === null || Number.isNaN(wait) || wait > LONG_HOLD_MS
    const resetPart = wait && wait > 0
      ? `resets ${formatClock(Date.parse(resetsAt!))} (in ${formatRelative(wait)})`
      : null
    let line2: string
    if (long) {
      line2 = `${win ?? 'binding'} window — long hold${resetPart ? `, ${resetPart}` : ', reset time unknown'}`
    } else {
      line2 = resetPart
        ? `${win ? `${win} window ` : ''}next ${resetPart}`
        : 'will fire when usage drops'
    }
    return {
      kind: 'auto-throttled',
      line1: `Auto · throttled (util ${formatUsageHoldDetail(utilizationHold)})`,
      line2,
    }
  }
  if (utilization === null || utilization === undefined) {
    return {
      kind: 'auto-soon',
      line1: `Auto · ${pendingCount} pending`,
      line2: 'checking token availability…',
    }
  }
  return {
    kind: 'auto-soon',
    line1: `Auto · ${pendingCount} pending · util ${utilization.toFixed(0)}%`,
    line2: `fires within 2 min (poll cycle)`,
  }
}

