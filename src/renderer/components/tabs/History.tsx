import { Panel } from '../ui/Panel'
import { HistoryDashboard } from './HistoryDashboard'

// The in-pane analytics control bar (measure/range/facet/refresh/export) now
// owns everything the old outer toolbar did; this shell is just routing.
export function History() {
  return (
    <Panel>
      <HistoryDashboard />
    </Panel>
  )
}
