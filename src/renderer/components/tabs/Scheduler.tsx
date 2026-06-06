import { useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SchedulePanel } from '../SchedulePanel'
import { SchedulerPrdsView } from './plans/SchedulerPrdsView'

/**
 * Scheduler — the single home for the claude -p batch workflow. Two tabs:
 *   • Queue — run & monitor the job queue (fire policy, concurrency, ETAs, logs)
 *   • PRDs  — author & edit the .md PRDs the queue executes (the old "Plans")
 *
 * Consolidates what used to be three separate nav destinations (Scheduler,
 * Plans, and the duplicate "Background Agents" tool) — all three read the same
 * queue.json + ~/.claude/session-manager/scheduled-plans/prds/ files. One
 * surface, no duplication.
 */

type SubView = 'queue' | 'prds'

const LS_KEY = 'sm.schedulerTab.subView'

const VIEW_OPTIONS = [
  { key: 'queue' as const, label: 'Queue' },
  { key: 'prds' as const, label: 'PRDs' },
]

export function Scheduler() {
  const [subView, setSubView] = useState<SubView>(() => {
    const stored = localStorage.getItem(LS_KEY)
    return stored === 'prds' ? 'prds' : 'queue'
  })

  useEffect(() => {
    localStorage.setItem(LS_KEY, subView)
  }, [subView])

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line">
        <ViewTabs options={VIEW_OPTIONS} active={subView} onChange={setSubView} />
        <span className="text-[11px] text-fg-faint">
          {subView === 'queue' ? 'run & monitor claude -p jobs' : 'author the PRDs the queue runs'}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        {subView === 'queue' ? <SchedulePanel /> : <SchedulerPrdsView />}
      </div>
    </div>
  )
}
