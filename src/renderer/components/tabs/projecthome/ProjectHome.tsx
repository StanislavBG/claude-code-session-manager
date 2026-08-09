/**
 * ProjectHome — the hosted Project Home document for the active project
 * (NavKey `project-home`).
 *
 * Layout, top to bottom, and it is deliberately ONE document viewer, not two:
 *
 *   1. a thin live strip (PhNow / PhOpenQuestions) — state that changes
 *      underneath a static document, so it stays live React rather than being
 *      folded into the generated HTML;
 *   2. the identity + provenance card holding the page's single
 *      "Generate My Project Home" action;
 *   3. `ProjectPagesSection` — every generated template, Home included,
 *      selected by tab.
 *
 * This file used to ALSO render `home.html` in its own iframe between (2) and
 * (3). Once Home became a tab in the Pages strip (five templates, matching
 * `LENS_ORDER` and the generator), that block was the same document painted
 * twice on one screen, one viewer directly on top of the other — the top one
 * with no tab strip and no full-screen affordance. Removed 2026-08-09; the
 * Pages widget now opens on Home by default so the screen still leads with it.
 * Don't reintroduce a second hosted iframe here.
 *
 * The synthesized purpose/what/areas/scope/conventions blocks this file used
 * to hand-render are the `brief` lens (ProjectPagesSection), generated from
 * the same `ProjectBrief` data instead of drawn twice — the same rule.
 */

import { memo, useEffect, useMemo } from 'react'
import { useSessions } from '../../../state/sessions'
import { usePromptSessions } from '../../../state/promptSessions'
import { useChatSignals } from '../../../lib/useChatSignals'
import { useScheduleState } from '../../../state/scheduleState'
import { useScheduledPrds } from '../../../lib/useScheduledPrds'
import { inFlightCards, openQuestions } from '../../../lib/projectHomeDerive'
import { setPendingPromptSessionId } from '../../../lib/promptSessionDeepLink'
import { formatAgo } from '../../../lib/formatTime'
import { useProjectPagesOutput } from '../../../lib/projectPages/useProjectPagesOutput'
import { useBuilderEpic } from '../../../lib/projectPages/useBuilderEpic'
import type { EpicSnapshots } from '../../../lib/epicDerive'
import type { ScheduleJob } from '../../../../preload/api'
import { EpicStatusChip } from '../../epics/epic-primitives'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../../state/toast'
import { PhBlock, PhCard } from './ph-primitives'
import { ProjectPagesSection } from './projectpages/ProjectPagesSection'

const EMPTY_JOBS: ScheduleJob[] = []

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd
}

function answerInEpic(epicId: string): void {
  setPendingPromptSessionId(epicId)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))
}

function PhNow({ cwd, snapshots }: { cwd: string; snapshots: EpicSnapshots }) {
  const cards = useMemo(() => inFlightCards(cwd, snapshots), [cwd, snapshots])
  return (
    <PhBlock kicker="now" title="What is in flight" note="Live from the session queue — this block is never hand-written.">
      {cards.length === 0 ? (
        <p className="text-xs text-fg-faint">No sessions in flight.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          {cards.map((card) => (
            <PhCard key={card.epicId} className="px-4 py-3.5 grid gap-1.5">
              <EpicStatusChip status={card.status} small />
              <span className="text-sm font-semibold text-fg leading-tight">{card.title}</span>
              <span className="text-xs text-fg-faint leading-relaxed">{card.note}</span>
            </PhCard>
          ))}
        </div>
      )}
    </PhBlock>
  )
}

function PhOpenQuestions({
  cwd,
  sessions,
  chats,
}: {
  cwd: string
  sessions: EpicSnapshots['sessions']
  chats: EpicSnapshots['chats']
}) {
  const questions = useMemo(() => openQuestions(cwd, sessions, chats), [cwd, sessions, chats])
  if (questions.length === 0) return null
  return (
    <PhBlock kicker="open" title="Waiting on you" note="Questions the last run could not resolve on its own.">
      <div className="grid gap-2.5">
        {questions.map((q) => (
          <div key={q.ticketId} className="rounded-xl border border-accent-dark/30 bg-accent/10 px-4 py-3.5">
            <div className="text-sm text-fg leading-relaxed">{q.question}</div>
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <span className="font-mono text-[10.5px] text-fg-faint">Epic · {q.epicGoalText}</span>
              <button
                type="button"
                onClick={() => answerInEpic(q.epicId)}
                className="shrink-0 rounded-md border border-line bg-bg-hi px-2.5 py-1 text-xs font-semibold text-fg-dim hover:text-fg"
              >
                Answer in Epic →
              </button>
            </div>
          </div>
        ))}
      </div>
    </PhBlock>
  )
}

function ProjectHomeComponent() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  const sessions = usePromptSessions((s) => s.sessions)
  // Signal-level chats snapshot — a raw whole-map `useChat((s) => s.chats)`
  // subscription would re-render on every streaming token (PRD 833 I6).
  const chats = useChatSignals()
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const prds = useScheduledPrds()

  const cwd = activeTab?.cwd ?? null
  useEffect(() => {
    if (!cwd) return
    void usePromptSessions.getState().hydrate(cwd)
    void usePromptSessions.getState().hydrateArchived(cwd)
  }, [cwd])

  // One fetch of session-manager-operations/project-pages/output/*.html,
  // shared with ProjectPagesSection below rather than fetched twice.
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

  const projectName = projectNameFromCwd(activeTab.cwd)
  const snapshots: EpicSnapshots = { sessions, chats, jobs: scheduleJobs, prds }
  const generatedMs = output?.generatedAt ? Date.parse(output.generatedAt) : NaN
  const provenanceLabel = output
    ? output.isDefault
      ? 'Shipped default — not yet generated for this project'
      : `generated ${formatAgo(Number.isNaN(generatedMs) ? null : generatedMs, Date.now())}`
    : ''

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <PhNow cwd={activeTab.cwd} snapshots={snapshots} />
        <PhOpenQuestions cwd={activeTab.cwd} sessions={sessions} chats={chats} />

        <div className="rounded-xl border border-line bg-bg-hi px-6 py-5 mb-3.5 flex items-start gap-4">
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wide text-fg-faint mb-2">
              Project Home
            </div>
            <h1 className="font-serif text-[26px] font-semibold text-fg leading-tight max-w-[760px]">
              {projectName}
            </h1>
            {loaded && (
              <div className="font-mono text-[10.5px] text-fg-faint mt-2 leading-relaxed">{provenanceLabel}</div>
            )}
          </div>
          <div className="ml-auto text-right shrink-0">
            <button
              type="button"
              onClick={handleGenerate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg-hi cursor-pointer hover:bg-accent-dark"
            >
              <span className="inline-flex">
                <AlmanacIcon name="sparkle" size={14} />
              </span>
              Generate My Project Home
            </button>
          </div>
        </div>

        <ProjectPagesSection output={output} loaded={loaded} />
      </div>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectHome = memo(ProjectHomeComponent)
