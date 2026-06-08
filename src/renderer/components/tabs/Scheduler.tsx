import { useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SchedulePanel } from '../SchedulePanel'
import { SchedulerPrdsView } from './plans/SchedulerPrdsView'
import { SchedulerHistoryView } from './plans/SchedulerHistoryView'
import { useScheduleState } from '../../state/scheduleState'
import { formatAgo, formatRelative } from '../../lib/formatTime'
import { AlmanacIcon } from '../layout/AlmanacIcon'
import { LegendItem } from './scheduler/sched-primitives'

/**
 * Scheduler — the single home for the claude -p batch workflow. Three tabs:
 *   • Queue   — run & monitor the job queue (fire policy, concurrency, ETAs, logs)
 *   • PRDs    — author & edit the .md PRDs the queue executes (the old "Plans")
 *   • History — last 50 completed/failed jobs with project + date-range filters
 *
 * Consolidates what used to be three separate nav destinations (Scheduler,
 * Plans, and the duplicate "Background Agents" tool) — all three read the same
 * queue.json + ~/.claude/session-manager/scheduled-plans/prds/ files. One
 * surface, no duplication.
 */

type SubView = 'queue' | 'prds' | 'history'

const LS_KEY = 'sm.schedulerTab.subView'

const VIEW_OPTIONS = [
  { key: 'queue' as const, label: 'Queue' },
  { key: 'prds' as const, label: 'PRDs' },
  { key: 'history' as const, label: 'History' },
]

function isToday(isoStr: string, nowMs: number): boolean {
  const d = new Date(isoStr)
  const t = new Date(nowMs)
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate()
}

// ─── Window status strip ─────────────────────────────────────────────────────

function WindowStrip() {
  const { snapshot } = useScheduleState()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!snapshot) return null

  const jobs = snapshot.jobs ?? []
  const pending   = jobs.filter(j => j.status === 'pending').length
  const running   = jobs.filter(j => j.status === 'running').length
  const completed = jobs.filter(j => j.status === 'completed' && (j.finishedAt ? isToday(j.finishedAt, now) : false)).length

  const nextResetMs = snapshot.nextReset ? new Date(snapshot.nextReset).getTime() : null
  const resetsIn = nextResetMs
    ? (nextResetMs > now ? formatRelative(nextResetMs - now) : 'soon')
    : '—'

  const lastBatch = formatAgo(
    snapshot.lastRunAt ? new Date(snapshot.lastRunAt).getTime() : null,
    now,
  )

  return (
    <div className="flex items-center gap-5 flex-wrap bg-bg-hi border border-line rounded-xl px-4 py-3">
      {/* Reset countdown */}
      <span className="inline-flex items-center gap-2 text-[13.5px] text-fg font-semibold whitespace-nowrap">
        <span className="text-sage" aria-hidden="true">
          <AlmanacIcon name="clock" size={15} />
        </span>
        Window resets in {resetsIn}
      </span>

      <span className="w-px h-[18px] bg-rule shrink-0" aria-hidden="true" />

      {/* Job legend */}
      <LegendItem dotClass="bg-fg-faint" n={pending}   label="pending" />
      <LegendItem dotClass="bg-accent"   n={running}   label="running" />
      <LegendItem dotClass="bg-sage"     n={completed} label="completed today" />

      {/* Utilization */}
      {snapshot.utilization !== null && snapshot.utilization !== undefined && (
        <>
          <span className="w-px h-[18px] bg-rule shrink-0" aria-hidden="true" />
          <span className="font-mono text-[12.5px] text-fg-faint">
            {Math.round(snapshot.utilization)}% of window used
          </span>
        </>
      )}

      {/* Last batch — right-aligned */}
      <span className="ml-auto font-mono text-[12.5px] text-fg-faint whitespace-nowrap">
        last batch {lastBatch}
      </span>
    </div>
  )
}

// ─── Scheduler shell ─────────────────────────────────────────────────────────

export function Scheduler() {
  const [subView, setSubView] = useState<SubView>(() => {
    const stored = localStorage.getItem(LS_KEY)
    return (stored === 'prds' || stored === 'history') ? stored : 'queue'
  })

  useEffect(() => {
    localStorage.setItem(LS_KEY, subView)
  }, [subView])

  return (
    <div className="h-full flex flex-col">
      {/* ── Header + window strip + sub-tabs ─────────────────────── */}
      <div className="shrink-0 px-9 pt-7 pb-0">
        <div className="text-xs font-bold text-fg-faint tracking-[0.8px] uppercase mb-1">
          Workspace
        </div>
        <h1 className="m-0 font-serif text-[40px] font-semibold leading-none tracking-tight text-fg">
          Scheduler
        </h1>
        <p className="mt-2 text-[14.5px] text-fg-dim leading-relaxed max-w-[600px]">
          Author PRDs and run them as{' '}
          <code className="font-mono text-[13.5px]">claude -p</code>{' '}
          jobs against your 5-hour window.
          Jobs auto-pause on rate-limit and resume on the next reset.
        </p>

        <div className="mt-[18px] mb-[22px]">
          <WindowStrip />
        </div>

        <div className="flex items-center gap-3 border-b border-line pb-0">
          <ViewTabs options={VIEW_OPTIONS} active={subView} onChange={setSubView} />
        </div>
      </div>

      {/* ── Content ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {subView === 'queue' && <SchedulePanel />}
        {subView === 'prds' && <SchedulerPrdsView />}
        {subView === 'history' && <SchedulerHistoryView />}
      </div>
    </div>
  )
}
