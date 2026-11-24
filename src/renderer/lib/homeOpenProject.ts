// Activate-or-open the SessionTab for a known project cwd. Its one caller is
// Home's ProjectsCard row click (Home.tsx); it owns the "does a tab for this
// cwd already exist?" join against useSessions.
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
