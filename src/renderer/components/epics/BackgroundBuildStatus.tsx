/**
 * BackgroundBuildStatus — the single Discussion status line for a
 * background-build Epic (a macro with `job` set: Demo Video, Project Home
 * pages, Competitor matrix). Those Epics never run a chat turn by design
 * (lib/useMacroLaunch.ts), so without this line the Discussion reads as a
 * session that never started. Pure props — EpicDetail derives them. Renders
 * nothing once the build job leaves pending/running (the DONE/FAILED result
 * is another surface's job).
 */
import { useEffect, useState } from 'react'
import type { ScheduleJob } from '../../../preload/api'
import { formatClock, formatTimingLabel } from '../../lib/formatTime'

const REFRESH_MS = 30_000

export interface BackgroundBuildStatusProps {
  /** Epic's source.macroId names a macro with `job` set. */
  isBackgroundBuild: boolean
  /** Slugs of the Epic's prd_created events, in timeline order. */
  prdCreatedSlugs: readonly string[]
  jobs: readonly ScheduleJob[]
  /** The Epic carries a 'job-not-queued' notice. */
  notQueued: boolean
  /** Fixed clock for tests; omitted = Date.now(), refreshed every 30 s. */
  now?: number
  onOpenPrd: (slug: string) => void
}

function prdNumber(slug: string): string {
  return /^(\d+)-/.exec(slug)?.[1] ?? slug
}

export function BackgroundBuildStatus({ isBackgroundBuild, prdCreatedSlugs, jobs, notQueued, now, onOpenPrd }: BackgroundBuildStatusProps) {
  const latestSlug = prdCreatedSlugs.length > 0 ? prdCreatedSlugs[prdCreatedSlugs.length - 1] : null
  const job = latestSlug ? jobs.find((j) => j.slug === latestSlug) ?? null : null
  const isRunning = isBackgroundBuild && job?.status === 'running'

  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (!isRunning || now !== undefined) return
    setTick(Date.now())
    const id = window.setInterval(() => setTick(Date.now()), REFRESH_MS)
    return () => window.clearInterval(id)
  }, [isRunning, now])

  if (!isBackgroundBuild) return null

  let text: string | null = null
  if (!latestSlug) {
    if (!notQueued) text = 'Queuing the background build…'
  } else if (job?.status === 'pending') {
    text = 'Queued — waiting for a free slot'
  } else if (job?.status === 'running') {
    const started = job.startedAt ? Date.parse(job.startedAt) : NaN
    const clock = now ?? tick
    text = Number.isFinite(started)
      ? `Building in the background — PRD #${prdNumber(job.slug)}, running since ${formatClock(started)} (${formatTimingLabel(clock - started)})`
      : `Building in the background — PRD #${prdNumber(job.slug)}`
  }
  if (!text) return null

  return (
    <div
      data-testid="epic-background-build-status"
      role="status"
      className="flex flex-wrap items-center justify-center gap-2 rounded-card border border-dashed border-rule px-3 py-2 text-xs text-fg-dim"
    >
      <span>{text}</span>
      {isRunning && latestSlug && (
        <button
          type="button"
          data-testid="epic-background-build-open"
          onClick={() => onOpenPrd(latestSlug)}
          className="whitespace-nowrap font-mono text-[11px] font-semibold text-accent hover:underline"
        >
          Open in Scheduler
        </button>
      )}
    </div>
  )
}
