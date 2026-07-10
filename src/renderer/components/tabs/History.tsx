import { useState } from 'react'
import { Panel } from '../ui/Panel'
import { HistoryDashboard } from './HistoryDashboard'

// Local-TZ ISO dates — must match the aggregator's bucket TZ (see
// historyAggregator.cjs's `localDate`), otherwise the upper bound mis-aligns
// for users west of UTC and today's data disappears.
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA')
}

function thirtyDaysAgoLocal(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toLocaleDateString('en-CA')
}

export function History() {
  const [fromDate, setFromDate] = useState(thirtyDaysAgoLocal)
  const [toDate, setToDate] = useState(todayLocal)
  const [projectFilter, setProjectFilter] = useState('')

  const dashToolbar = (
    <>
      <input
        type="date"
        value={fromDate}
        onChange={(e) => setFromDate(e.target.value)}
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg"
      />
      <span className="text-fg-faint">–</span>
      <input
        type="date"
        value={toDate}
        onChange={(e) => setToDate(e.target.value)}
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg"
      />
      <input
        value={projectFilter}
        onChange={(e) => setProjectFilter(e.target.value)}
        placeholder="filter by project"
        className="bg-bg-elev border border-line rounded px-2 py-1 text-xs text-fg placeholder-fg-faint w-48"
      />
      <div className="flex-1" />
    </>
  )

  return (
    <Panel toolbar={dashToolbar}>
      <HistoryDashboard
        fromDate={fromDate}
        toDate={toDate}
        projectFilter={projectFilter}
        onProjectClick={(cwd) => setProjectFilter(cwd)}
      />
    </Panel>
  )
}
