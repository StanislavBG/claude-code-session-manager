import { memo, useEffect, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { usePromptSessions } from '../../state/promptSessions'
import { SchedulerTopBands, type SubView, type PlanMode } from './scheduler/SchedulerTopBands'
import { SchedulePanel } from '../SchedulePanel'
import { SchedulerPrdsView } from './plans/SchedulerPrdsView'
import { SchedulerHistoryView } from './plans/SchedulerHistoryView'
import { SessionManagerConfig } from './SessionManagerConfig'
import type { NavKey } from '../../lib/navKey'

/**
 * Scheduler — ONE screen for both sidebar faces (Home and Project), no fork
 * on navFace. Previously (2026-08-01, commit 481cef1) this split into two
 * genuinely different screens — Home's "Scheduler Configs" (global policy
 * only, no PRDs) vs. Project's "Epic's Execution Queue" (this project's live
 * PRD queue, no global config) — reached via lib/navGroups.ts's labelByFace.
 * That split was reverted the same day: the two screens dodged real overlap
 * (SessionManagerConfig's "Scheduler policy" section duplicated the exact
 * same fire-policy/concurrency/threshold controls SchedulePanel's PolicyBar
 * already renders live) instead of resolving it, so it's back to one
 * combined view — with four destinations split by how often the content
 * changes (2026-08 restyle): three tabs in one segmented pillbar for the
 * per-project, minute-to-minute surfaces, plus a separate "Machine" pill for
 * the monthly-changing global config — scheduler.cjs's reconcile()
 * (src/main/scheduler.cjs:35, run on every scan/tick) walks prds/ and gives
 * every .md a queue.json entry immediately, so Queue and PRDs always show the
 * same underlying slugs; there is no "authored but not yet queued" state to
 * distinguish them by:
 *   • Queue   — OPERATE: live status strip, fire policy, and this project's
 *     job execution (per-job status/ETA/logs, reset/resume actions).
 *   • PRDs    — AUTHOR: edit the .md source (structured frontmatter form +
 *     body editor, lint, archive/retag) — the old "Plans"
 *   • History — last 50 completed/failed jobs with project + date-range filters
 *   • Machine — global session pool, fire-policy scaffolding, on-disk paths;
 *     applies to every project, not just the active tab (SessionManagerConfig).
 * scopeCwd derives directly from the active tab's cwd every render (no
 * stored scope state): the currently-active project's tab, or null (every
 * project) if no tab is active — e.g. sitting on the Home face with nothing
 * open. There is no manual "All projects" escape hatch; to see another
 * project's queue, switch tabs (matches HistoryDashboard's scoping).
 */

const LS_KEY = 'sm.schedulerTab.subView'

// ─── Scheduler shell ─────────────────────────────────────────────────────────

interface SchedulerProps {
  navigate?: (k: NavKey) => void
}

function SchedulerComponent({ navigate }: SchedulerProps = {}) {
  // Graph | List | Critical path is state only in this PRD — Graph and List both
  // render today's job list; the modes land in later PRDs.
  const [planMode, setPlanMode] = useState<PlanMode>('graph')
  // Drives SchedulePanel's job filter (text is session-only, as before; status persists there).
  const [filterText, setFilterText] = useState('')
  const [subView, setSubView] = useState<SubView>(() => {
    const stored = localStorage.getItem(LS_KEY)
    return (stored === 'prds' || stored === 'history' || stored === 'machine') ? stored : 'queue'
  })
  // scopeCwd is derived directly from activeCwd every render, not stored
  // state — the currently-active project's tab, or null (every project) if
  // no tab is active. No manual "all projects" escape hatch.
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeCwd = tabs.find((t) => t.id === activeTabId)?.cwd ?? null
  const scopeCwd = activeCwd

  // Epic names shown on Queue/PRD/History rows come from the promptSessions
  // store, which is hydrated lazily per project. Without this, booting
  // straight into Scheduler renders bare epic ids until the user happens to
  // visit Home or Epics. Archived Epics are hydrated too — History rows point
  // at Epics that are, by definition, usually finished.
  useEffect(() => {
    if (!activeCwd) return
    void usePromptSessions.getState().hydrate(activeCwd)
    void usePromptSessions.getState().hydrateArchived(activeCwd)
  }, [activeCwd])

  useEffect(() => {
    localStorage.setItem(LS_KEY, subView)
  }, [subView])

  return (
    <div className="h-full flex flex-col">
      {/* ── 2A bands: title 46px / KPI 78px / PLANS toolbar 32px ──── */}
      <SchedulerTopBands
        scopeCwd={scopeCwd}
        subView={subView}
        onSubView={setSubView}
        filterText={filterText}
        onFilterText={setFilterText}
        planMode={planMode}
        onPlanMode={setPlanMode}
      />

      {/* ── Content ──────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {subView === 'queue' && <SchedulePanel scopeCwd={scopeCwd} navigate={navigate} filterText={filterText} />}
        {subView === 'prds' && <SchedulerPrdsView scopeCwd={scopeCwd} />}
        {subView === 'history' && <SchedulerHistoryView scopeCwd={scopeCwd} />}
        {subView === 'machine' && (
          <div className="h-full overflow-y-auto px-9 py-6">
            <SessionManagerConfig navigate={navigate} />
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized: `navigate` is a stable ScreenRenderCtx callback identity; own
// data comes from store hooks inside the component.
export const Scheduler = memo(SchedulerComponent)
