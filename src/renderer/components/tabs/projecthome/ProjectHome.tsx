/**
 * ProjectHome — "The Brief" for the active project (NavKey `project-home`).
 *
 * Scaffold only: routing + header + empty states. The synthesized brief
 * content (purpose/what/areas/scope/conventions) and the live Now/Waiting-on-
 * you blocks land in later PRDs (839/840) — this component intentionally
 * does not touch `window.api.projectBrief`.
 */

import { useSessions } from '../../../state/sessions'
import { EmptyState } from '../../ui/EmptyState'

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

export function ProjectHome() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  if (!activeTab) {
    return <EmptyState title="Open a project to see its brief" />
  }

  const projectName = projectNameFromCwd(activeTab.cwd)

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <div className="rounded-xl border border-line bg-bg-hi px-6 py-5 mb-6">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-accent mb-2">
            The Brief
          </div>
          <h1 className="font-serif text-[26px] font-semibold text-fg">{projectName}</h1>
          <p className="mt-2 text-xs text-fg-faint">{activeTab.cwd}</p>
        </div>
        <EmptyState
          title="No brief yet"
          hint="Brief synthesis and live project state land in a later update."
        />
      </div>
    </div>
  )
}
