/**
 * ProjectHome — the hosted Project Home document for the active project
 * (NavKey `project-home`): nothing but `ProjectPagesSection`, the single
 * generated home.html view and its Generate/Regenerate button.
 * Don't reintroduce a second hosted iframe or hand-written blocks here.
 */

import { memo } from 'react'
import { useSessions } from '../../../state/sessions'
import { useProjectPagesOutput } from '../../../lib/projectPages/useProjectPagesOutput'
import { useBuilderEpic } from '../../../lib/projectPages/useBuilderEpic'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../../state/toast'
import { ProjectPagesSection } from './projectpages/ProjectPagesSection'

function ProjectHomeComponent() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  const cwd = activeTab?.cwd ?? null

  // One fetch of session-manager-operations/project-pages/home.html.
  const { output, loaded } = useProjectPagesOutput(cwd)
  const { generate } = useBuilderEpic(cwd)

  const handleGenerate = () => {
    generate().catch((err: unknown) => {
      toast.error(err instanceof Error ? err.message : String(err))
    })
  }

  if (!activeTab) {
    return <EmptyState title="Open a project to see its brief" />
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <ProjectPagesSection output={output} loaded={loaded} onGenerate={handleGenerate} />
      </div>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectHome = memo(ProjectHomeComponent)
