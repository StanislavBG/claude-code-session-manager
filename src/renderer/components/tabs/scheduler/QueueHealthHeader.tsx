import { useEffect, useState } from 'react'
import type { ScheduleQueueHealthResult, ScheduleQueueHealthVerdict } from '../../../../preload/api.d'
import { formatAgo, formatRelative } from '../../../lib/formatTime'

/**
 * QueueHealthHeader — the one honest read of "why does the queue look
 * stale", derived entirely from schedule:queue-health (main's
 * classifyQueueHealth, which reuses classifyQueueStarvation so this can
 * never disagree with the starvation watchdog). Distinguishes the three
 * genuinely different causes a human staring at a stalled-looking queue
 * needs told apart: all slots occupied by long-running jobs, every pending
 * row blocked behind a dependency/needs_review, or the dispatch driver
 * itself never attempted a tick.
 *
 * Polled (schedule:state already broadcasts on every mutation, but the
 * verdict depends on machine-wide slot occupancy and wall-clock idle time
 * that changes between mutations too — a 15s poll keeps "stalled" honest
 * without needing a second broadcast channel for one screen).
 */

const POLL_MS = 15_000

const KIND_STYLE: Record<ScheduleQueueHealthVerdict['kind'], string> = {
  paused: 'bg-amber-950/60 border-amber-700/50 text-amber-200',
  'launch-blocked': 'bg-red-950/60 border-red-700/50 text-red-200',
  blocked: 'bg-red-950/60 border-red-700/50 text-red-200',
  stalled: 'bg-amber-950/60 border-amber-700/50 text-amber-200',
  saturated: 'bg-bg-hi border-line text-fg-dim',
  idle: 'bg-bg-hi border-line text-fg-dim',
  running: 'bg-bg-hi border-line text-fg-dim',
}

function headline(v: ScheduleQueueHealthVerdict, oldestRunningAgeMs: number | null): string {
  switch (v.kind) {
    case 'paused':
      return `paused: scheduler is paused (${v.reason ?? 'manual'})`
    case 'launch-blocked':
      return `launch-blocked: ${v.agentType} jobs can't launch${v.block?.kind ? ` (${v.block.kind})` : ''}`
    case 'idle':
      return 'idle: 0 pending'
    case 'saturated': {
      const oldest = oldestRunningAgeMs != null ? `, oldest ${formatRelative(oldestRunningAgeMs)}` : ''
      return `saturated: ${v.totalSlots ?? '?'} slot(s) busy${oldest}`
    }
    case 'blocked': {
      const chains = v.blockedChains.length
      return `blocked: ${v.pending} pending, ${v.dispatchable} dispatchable — ${chains} chain${chains === 1 ? '' : 's'} stuck behind a failed/skipped dependency`
    }
    case 'stalled':
      return `stalled: no dispatch attempt in ${v.idleMs != null ? formatRelative(v.idleMs) : '?'} with ${v.dispatchable} dispatchable`
    case 'running':
    default:
      return `running: ${v.runningCount} in flight, ${v.pending} pending`
  }
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-faint whitespace-nowrap" title={title}>
      {label} <strong className="text-fg font-mono text-[12.5px]">{value}</strong>
    </span>
  )
}

export function QueueHealthHeader({ scopeCwd }: { scopeCwd: string | null }) {
  const [result, setResult] = useState<ScheduleQueueHealthResult | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    const load = () => {
      void window.api.schedule.queueHealth(scopeCwd).then((r) => { if (alive) setResult(r) })
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [scopeCwd])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!result) return null

  if (result.unknown) {
    return (
      <div
        data-testid="queue-health-header"
        data-verdict-kind="unknown"
        className="flex items-center gap-3 border rounded-xl px-4 py-2.5 text-[13px] bg-bg-hi border-line text-fg-faint"
      >
        Queue health: unknown — {result.reason ?? 'state unavailable'}
      </div>
    )
  }

  const v = result.verdict!
  const slots = result.slots!

  return (
    <div
      data-testid="queue-health-header"
      data-verdict-kind={v.kind}
      className={`flex flex-col gap-2 border rounded-xl px-4 py-2.5 text-[13px] ${KIND_STYLE[v.kind]}`}
    >
      <div className="font-medium">{headline(v, result.oldestRunningAgeMs ?? null)}</div>
      <div className="flex items-center gap-4 flex-wrap text-fg-dim">
        <Stat
          label="slots"
          value={`${slots.inUse}/${slots.total}`}
          title={`Machine-wide session pool (${slots.source === 'env' ? 'SM_SESSION_SLOTS override' : 'Home tab cap'}), not scoped to this project`}
        />
        <Stat
          label="oldest running"
          value={result.oldestRunningAgeMs != null ? formatRelative(result.oldestRunningAgeMs) : '—'}
          title="Across every project on this machine"
        />
        <Stat label="pending" value={String(v.pending)} />
        <Stat
          label="dispatchable"
          value={String(v.dispatchable)}
          title="Pending rows whose dependsOn chain is fully satisfied right now"
        />
        <Stat label="needs_review" value={String(v.needsReviewCount)} />
        <Stat
          label="last batch fired"
          value={formatAgo(result.lastRunAt ? Date.parse(result.lastRunAt) : null, now)}
          title="lastRunAt — only advances when tickQueue actually launches a job"
        />
        <Stat
          label="last dispatch attempt"
          value={formatAgo(result.lastDispatchAttemptAt ? Date.parse(result.lastDispatchAttemptAt) : null, now)}
          title="lastDispatchAttemptAt — advances every time the driver evaluates the queue, whether or not it launched anything"
        />
      </div>
    </div>
  )
}
