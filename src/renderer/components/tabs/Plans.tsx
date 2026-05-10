import { useEffect, useState } from 'react'
import { ViewTabs } from '../ui/ViewTabs'
import { SchedulerPrdsView } from './plans/SchedulerPrdsView'
import { SessionPlansView } from './plans/SessionPlansView'

type SubView = 'prds' | 'session'

const LS_KEY = 'sm.plansTab.subView'

const VIEW_OPTIONS = [
  { key: 'prds' as const, label: 'Scheduler PRDs' },
  { key: 'session' as const, label: 'Session Plans' },
]

export function Plans() {
  const [subView, setSubView] = useState<SubView>(() => {
    const stored = localStorage.getItem(LS_KEY)
    return stored === 'session' ? 'session' : 'prds'
  })

  useEffect(() => {
    localStorage.setItem(LS_KEY, subView)
  }, [subView])

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-line">
        <ViewTabs options={VIEW_OPTIONS} active={subView} onChange={setSubView} />
      </div>
      <div className="flex-1 min-h-0">
        {subView === 'prds' ? <SchedulerPrdsView /> : <SessionPlansView />}
      </div>
    </div>
  )
}
