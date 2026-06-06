import { useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SchedulePanel } from '../SchedulePanel'
import { SchedulerPrdsView } from './plans/SchedulerPrdsView'
import { SchedulerHistoryView } from './plans/SchedulerHistoryView'

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

const SUBTITLES: Record<SubView, string> = {
  queue: 'run & monitor claude -p jobs',
  prds: 'author the PRDs the queue runs',
  history: 'completed & failed job log',
}

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
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line">
        <ViewTabs options={VIEW_OPTIONS} active={subView} onChange={setSubView} />
        <span className="text-[11px] text-fg-faint">{SUBTITLES[subView]}</span>
      </div>
      <div className="flex-1 min-h-0">
        {subView === 'queue' && <SchedulePanel />}
        {subView === 'prds' && <SchedulerPrdsView />}
        {subView === 'history' && <SchedulerHistoryView />}
      </div>
    </div>
  )
}
