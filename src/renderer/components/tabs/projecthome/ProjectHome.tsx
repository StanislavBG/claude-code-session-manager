/**
 * ProjectHome — the hosted Project Home document for the active project
 * (NavKey `project-home`): the Pages / Videos / Tools key buttons over
 * `ProjectPagesSection`, driven by every `surface: 'project-home'` Macro
 * (Project Home + Demo Video, plus any custom ones) pressed through the same
 * `useMacroLaunch` authority the Sessions HOT KEYS strip uses. Owns the active
 * key tab and the key buttons' numbers. Don't reintroduce a second hosted
 * iframe or hand-written blocks here.
 *
 * Also owns this window's last Pages / Videos launch per project and macro
 * (`BuildLaunch`: title, sent lines, entry replaced) — component state only, so
 * an app reload forgets it and the panes fall back to the macro label — and the
 * `“<title>” is ready` toast when a macro's job goes from queued / running to
 * done (Project Home v2 DESIGN_SPEC §4).
 */

import { memo, useCallback, useMemo, useState } from 'react'
import { useSessions } from '../../../state/sessions'
import { toast } from '../../../state/toast'
import { useProjectPagesOutput } from '../../../lib/projectPages/useProjectPagesOutput'
import { useMacroJobStatus } from '../../../lib/projectPages/useMacroJobStatus'
import { useMacros, macrosForProject } from '../../../lib/useMacros'
import { useAgentPersonas } from '../../../lib/useAgentPersonas'
import { useMacroLaunch } from '../../../lib/useMacroLaunch'
import { setPendingPromptSessionId } from '../../../lib/promptSessionDeepLink'
import { EmptyState } from '../../ui/EmptyState'
import { ProjectPagesSection } from './projectpages/ProjectPagesSection'
import { ProjectHomeKeyButtons, libraryKeyStats, type ProjectHomeTab } from './projectpages/ProjectHomeKeyButtons'
import { useJobSettled, type BuildLaunch } from './projectpages/BuildingPanel'
import type { MacroJobStatus } from '../../../../preload/api'

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
  const { macros: library } = useMacros()
  const macros = useMemo(() => macrosForProject(library, cwd, 'project-home'), [library, cwd])
  const personas = useAgentPersonas()
  const { launch, launching } = useMacroLaunch(navigateToEpic, personas)
  const [tab, setTab] = useState<ProjectHomeTab>('pages')
  // cwd → macro id → this window's last launch: the building row's title and BuildingPanel's sent lines.
  const [launches, setLaunches] = useState<Record<string, Record<string, BuildLaunch>>>({})
  const cwdLaunches = cwd ? launches[cwd] : undefined
  const recordLaunch = useCallback(
    (macroId: string, launched: BuildLaunch) => {
      if (!cwd) return
      setLaunches((all) => ({ ...all, [cwd]: { ...all[cwd], [macroId]: launched } }))
    },
    [cwd],
  )
  // A finished build toasts once, under its launch title (the macro label after a reload), and its
  // launch is dropped so a later job this window did not start never shows its title or lines.
  const onJobSettled = useCallback(
    (status: MacroJobStatus) => {
      if (status.state === 'done') {
        const title =
          cwdLaunches?.[status.macroId]?.title ?? macros.find((m) => m.id === status.macroId)?.label ?? status.macroId
        toast.success(`“${title}” is ready`)
      }
      if (!cwd || !cwdLaunches?.[status.macroId]) return
      setLaunches((all) => {
        const kept = { ...all[cwd] }
        delete kept[status.macroId]
        return { ...all, [cwd]: kept }
      })
    },
    [cwd, cwdLaunches, macros],
  )
  useJobSettled(cwd, jobStatus, onJobSettled)
  // A queued/running job for a library's generate macro counts as one building entry.
  const pageStats = useMemo(() => libraryKeyStats(knowledge, jobStatus['builtin-project-home']), [knowledge, jobStatus])
  const videoStats = useMemo(() => libraryKeyStats(videos, jobStatus['builtin-demo-video']), [videos, jobStatus])

  if (!activeTab) {
    return <EmptyState title="Open a project to see its brief" />
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-[18px] overflow-hidden px-[28px] pt-[22px] pb-[20px] text-fg">
      {/* findingsCount stays null (badge hidden) until the Tools pane brings the link-map scan. */}
      <ProjectHomeKeyButtons tab={tab} onTabChange={setTab} pages={pageStats} videos={videoStats} findingsCount={null} />
      <ProjectPagesSection
        tab={tab}
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
        launches={cwdLaunches}
        onLaunched={recordLaunch}
        onGoTools={() => setTab('tools')}
      />
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectHome = memo(ProjectHomeComponent)
