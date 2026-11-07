/**
 * ProjectHome — the hosted Project Home document for the active project
 * (NavKey `project-home`): nothing but `ProjectPagesSection`, driven by every
 * `surface: 'project-home'` Macro (Project Home + Demo Video, plus any
 * custom ones) pressed through the same `useMacroLaunch` authority the
 * Sessions HOT KEYS strip uses. Don't reintroduce a second hosted iframe or
 * hand-written blocks here.
 */

import { memo } from 'react'
import { useSessions } from '../../../state/sessions'
import { useProjectPagesOutput } from '../../../lib/projectPages/useProjectPagesOutput'
import { useMacroJobStatus } from '../../../lib/projectPages/useMacroJobStatus'
import { useMacros, macrosForProject } from '../../../lib/useMacros'
import { useAgentPersonas } from '../../../lib/useAgentPersonas'
import { useMacroLaunch } from '../../../lib/useMacroLaunch'
import { setPendingPromptSessionId } from '../../../lib/promptSessionDeepLink'
import { EmptyState } from '../../ui/EmptyState'
import { ProjectPagesSection } from './projectpages/ProjectPagesSection'

function navigateToEpic(id: string): void {
  setPendingPromptSessionId(id)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

function ProjectHomeComponent() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  const cwd = activeTab?.cwd ?? null

  // One fetch of session-manager-operations/project-pages/home.html (+ demo video).
  const { knowledge, videos, loaded, error, reload } = useProjectPagesOutput(cwd)
  const jobStatus = useMacroJobStatus(cwd)
  const library = useMacros()
  const macros = macrosForProject(library, cwd, 'project-home')
  const personas = useAgentPersonas()
  const { launch, launching } = useMacroLaunch(navigateToEpic, personas)

  if (!activeTab) {
    return <EmptyState title="Open a project to see its brief" />
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <ProjectPagesSection
          cwd={cwd}
          knowledge={knowledge}
          videos={videos}
          loaded={loaded}
          error={error}
          onRetry={reload}
          macros={macros}
          launching={launching}
          onLaunch={launch}
          jobStatus={jobStatus}
          onOpenSession={navigateToEpic}
        />
      </div>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectHome = memo(ProjectHomeComponent)
