/**
 * QueuedJobPopover — small anchored popover shown when a QueuedCard row is
 * clicked (Home Screen A's `queuePop`, variants/home-a.jsx), rebuilt with
 * this app's Tailwind tokens. Shows only real job fields (title/slug,
 * project, estimateMinutes, status) and only real actions: "Open in
 * Scheduler" always, "Nudge scheduler now" only for a still-pending job
 * (wired to `schedule.runNow()`, which wakes the whole queue rather than
 * targeting this job specifically — see the button's title). No "Skip
 * next" — no per-job skip API exists in this codebase.
 */
import { useEffect, useRef } from 'react'
import type { ScheduleJob } from '../../../../preload/api'

export interface QueuedJobPopoverJob {
  slug: string
  title: string
  cwd: string | null
  estimateMinutes: number | null
  status: ScheduleJob['status']
}

export function QueuedJobPopover({
  job,
  onClose,
  onOpenScheduler,
  onRunNow,
}: {
  job: QueuedJobPopoverJob
  onClose: () => void
  onOpenScheduler: () => void
  onRunNow?: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      data-testid="queue-job-popover"
      className="absolute z-20 top-full left-0 mt-1.5 w-[226px] bg-bg-hi border border-line rounded-[11px] shadow-xl px-3.5 py-3"
    >
      <div className="font-mono text-[12px] font-semibold text-fg truncate mb-1.5">{job.title || job.slug}</div>
      <dl className="m-0 grid gap-1 mb-3" style={{ gridTemplateColumns: 'minmax(0,60px) minmax(0,1fr)' }}>
        <dt className="m-0 font-mono text-[10px] uppercase tracking-[0.05em] text-fg-faint">Slug</dt>
        <dd className="m-0 font-mono text-[11px] text-fg-dim truncate">{job.slug}</dd>
        <dt className="m-0 font-mono text-[10px] uppercase tracking-[0.05em] text-fg-faint">Project</dt>
        <dd className="m-0 font-mono text-[11px] text-fg-dim truncate">{job.cwd ? projectNameFromCwd(job.cwd) : '—'}</dd>
        {job.estimateMinutes != null && (
          <>
            <dt className="m-0 font-mono text-[10px] uppercase tracking-[0.05em] text-fg-faint">Est.</dt>
            <dd className="m-0 font-mono text-[11px] text-fg-dim">~{job.estimateMinutes}m</dd>
          </>
        )}
        <dt className="m-0 font-mono text-[10px] uppercase tracking-[0.05em] text-fg-faint">Status</dt>
        <dd className="m-0 font-mono text-[11px] text-fg-dim">{job.status}</dd>
      </dl>
      <div className="flex flex-col gap-1.5">
        <button
          onClick={onOpenScheduler}
          className="text-[11.5px] font-semibold px-2.5 py-[5px] rounded-md border border-line bg-bg text-fg-dim hover:bg-bg-elev text-left"
        >
          Open in Scheduler →
        </button>
        {onRunNow && (
          <button
            onClick={onRunNow}
            title="Wakes the scheduler to check for due jobs immediately — does not force this specific job to run out of turn or bypass the concurrency cap."
            className="text-[11.5px] font-semibold px-2.5 py-[5px] rounded-md bg-accent text-bg-hi hover:bg-accent-dark text-left"
          >
            Nudge scheduler now
          </button>
        )}
      </div>
    </div>
  )
}

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}
