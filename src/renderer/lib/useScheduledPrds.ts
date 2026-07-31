import { useEffect, useState } from 'react'
import { useScheduleState } from '../state/scheduleState'
import type { PrdListItem, ScheduleJob } from '../../preload/api'

const EMPTY_JOBS: ScheduleJob[] = []
const EMPTY_PRDS: PrdListItem[] = []

/**
 * Shared `window.api.schedule.listPrds()` fetch, re-run whenever a schedule
 * snapshot broadcast changes the job list — single source of truth used by
 * both EpicsWorkspace (queue PRD-count badges) and EpicDetail (PRDs tab) so
 * the two never race independent fetches of the same data and briefly
 * disagree.
 */
export function useScheduledPrds(): PrdListItem[] {
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const [prds, setPrds] = useState<PrdListItem[]>(EMPTY_PRDS)

  useEffect(() => {
    let alive = true
    window.api.schedule
      .listPrds()
      .then((list) => {
        if (alive) setPrds(list)
      })
      .catch(() => {
        if (alive) setPrds(EMPTY_PRDS)
      })
    return () => {
      alive = false
    }
  }, [scheduleJobs])

  return prds
}
