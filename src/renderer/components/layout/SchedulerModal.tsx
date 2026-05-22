import { TabModal } from './TabModal'
import { SchedulePanel } from '../SchedulePanel'

/**
 * Scheduler modal — hosts the existing SchedulePanel that used to live in
 * LeftNav's bottom stack. Same component, no logic changes.
 */
export function SchedulerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <TabModal open={open} onClose={onClose} title="Scheduler — PRD queue">
      <div className="p-2">
        <SchedulePanel />
      </div>
    </TabModal>
  )
}
