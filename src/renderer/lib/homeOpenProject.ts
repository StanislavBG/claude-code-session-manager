// Activate-or-open the SessionTab for a known project cwd. Single
// implementation shared by Home's ProjectsCard row click and the New-epic
// project picker drawer (NewEpicProjectDrawer) — both need the exact same
// "does a tab for this cwd already exist?" join against useSessions.
import type { useSessions } from '../state/sessions'

type Tabs = ReturnType<typeof useSessions.getState>['tabs']
type AddTab = ReturnType<typeof useSessions.getState>['addTab']
type SetActive = ReturnType<typeof useSessions.getState>['setActive']

export function openProjectTab(cwd: string, tabs: Tabs, addTab: AddTab, setActive: SetActive): void {
  const existing = tabs.find((t) => t.cwd === cwd)
  if (existing) {
    setActive(existing.id)
  } else {
    addTab({ cwd, startupCommand: null, dormant: true })
  }
}
