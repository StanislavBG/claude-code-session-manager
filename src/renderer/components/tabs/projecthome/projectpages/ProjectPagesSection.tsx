/**
 * Project Home's section area under the key buttons; ProjectHome's `tab` picks
 * what it shows. `pages`: PagesPane — the knowledge-page list (252px column)
 * beside the selected page. `videos`: VideosPane — the same layout, the video
 * list beside the VideoPlayer with its SOURCES and QUALITY REPORT cards. Both
 * build through the Generate composer (Generate page|video, Regenerate…).
 * `tools`: ToolsPane — the same list | content layout, Review MD network first,
 * then every other project-home macro (there is no hot-key strip any more).
 * The loading / load-error states cover pages and videos.
 *
 * `knowledge`/`videos`/`loaded` come from ProjectHome's single
 * `useProjectPagesOutput` call; `macros`/`launching`/`onLaunch` come from its
 * `useMacroLaunch` wiring; `launches`/`onLaunched` are its per-macro record of
 * this window's last Pages / Videos launch, which the panes' building state
 * shows (title, sent lines). Purely presentational — no store access here; the
 * page and video selections live here so they survive key-button switches.
 */
import { useState } from 'react'
import { PagesPane } from './PagesPane'
import { VideosPane } from './VideosPane'
import { ToolsPane, type LaunchFn } from './ToolsPane'
import type { ProjectHomeTab } from './ProjectHomeKeyButtons'
import type { BuildLaunch } from './BuildingPanel'
import type { ProjectKnowledgeEntry, ProjectVideoEntry } from '../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus } from '../../../../../preload/api'

export function ProjectPagesSection({
  tab,
  cwd,
  knowledge,
  videos,
  loaded,
  error,
  onRetry,
  macros,
  launching,
  onLaunch,
  jobStatus,
  onOpenSession,
  launches,
  onLaunched,
}: {
  tab: ProjectHomeTab
  cwd?: string | null
  knowledge: ProjectKnowledgeEntry[]
  videos: ProjectVideoEntry[]
  loaded: boolean
  error?: string | null
  onRetry?: () => void
  macros: Macro[]
  launching: string | null
  onLaunch: LaunchFn
  jobStatus?: Record<string, MacroJobStatus>
  onOpenSession?: (epicId: string) => void
  /** This window's last launch per macro id (ProjectHome); empty after an app reload. */
  launches?: Record<string, BuildLaunch>
  onLaunched?: (macroId: string, launch: BuildLaunch) => void
}) {
  const [knowledgeId, setKnowledgeId] = useState<string | null>(null)
  const [videoId, setVideoId] = useState<string | null>(null)

  if (tab === 'tools') {
    return (
      <div data-testid="project-home-section" data-tab={tab} className="flex min-h-0 flex-1 flex-col">
        <ToolsPane cwd={cwd} macros={macros} launching={launching} onLaunch={onLaunch} />
      </div>
    )
  }

  const failed = typeof error === 'string' && error !== ''

  return (
    <div data-testid="project-home-section" data-tab={tab} className="flex min-h-0 flex-1 flex-col">
      {failed ? (
        <div data-testid="project-home-load-error" className="flex min-h-0 flex-1 justify-center overflow-auto py-16">
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-xs text-red-400">Could not load pages: {error}</span>
            <button
              type="button"
              data-testid="project-home-retry"
              onClick={() => onRetry?.()}
              className="px-2 py-1 rounded text-[11px] font-semibold bg-bg-elev text-fg hover:bg-bg-hi"
            >
              Retry
            </button>
          </div>
        </div>
      ) : !loaded ? (
        <div data-testid="project-home-loading" className="flex min-h-0 flex-1 justify-center overflow-auto py-16">
          <span className="text-xs text-fg-faint">Loading pages…</span>
        </div>
      ) : tab === 'pages' ? (
        <PagesPane
          cwd={cwd}
          entries={knowledge}
          macro={macros.find((m) => m.id === 'builtin-project-home')}
          launching={launching}
          onLaunch={onLaunch}
          jobStatus={jobStatus?.['builtin-project-home']}
          onOpenSession={onOpenSession}
          selectedId={knowledgeId}
          onSelect={setKnowledgeId}
          lastLaunch={launches?.['builtin-project-home']}
          onLaunched={onLaunched}
        />
      ) : (
        <VideosPane
          cwd={cwd}
          entries={videos}
          macro={macros.find((m) => m.id === 'builtin-demo-video')}
          launching={launching}
          onLaunch={onLaunch}
          jobStatus={jobStatus?.['builtin-demo-video']}
          onOpenSession={onOpenSession}
          selectedId={videoId}
          onSelect={setVideoId}
          lastLaunch={launches?.['builtin-demo-video']}
          onLaunched={onLaunched}
        />
      )}
    </div>
  )
}
