import { memo } from 'react'
import { Panel } from '../ui/Panel'
import { HistoryDashboard } from './HistoryDashboard'

// The in-pane analytics control bar (measure/range/facet/refresh/export) now
// owns everything the old outer toolbar did; this shell is just routing.
function HistoryComponent() {
  return (
    <Panel>
      <HistoryDashboard />
    </Panel>
  )
}

// Memoized: no props; HistoryDashboard owns its own store subscriptions.
export const History = memo(HistoryComponent)
