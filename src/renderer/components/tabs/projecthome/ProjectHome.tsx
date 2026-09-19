/**
 * ProjectHome — the hosted Project Home document for the active project
 * (NavKey `project-home`): a thin live strip (PhNow / PhOpenQuestions /
 * PhAgentTools) above `ProjectPagesSection`, the single home.html view.
 * Don't reintroduce a second hosted iframe here.
 */

import { memo, useEffect, useMemo } from 'react'
import { useSessions } from '../../../state/sessions'
import { usePromptSessions } from '../../../state/promptSessions'
import { useChatSignals } from '../../../lib/useChatSignals'
import { useScheduleState } from '../../../state/scheduleState'
import { useScheduledPrds } from '../../../lib/useScheduledPrds'
import { inFlightCards, openQuestions } from '../../../lib/projectHomeDerive'
import { setPendingPromptSessionId } from '../../../lib/promptSessionDeepLink'
import { useProjectPagesOutput } from '../../../lib/projectPages/useProjectPagesOutput'
import { useBuilderEpic } from '../../../lib/projectPages/useBuilderEpic'
import type { EpicSnapshots } from '../../../lib/epicDerive'
import type { ScheduleJob } from '../../../../preload/api'
import { EpicStatusChip } from '../../epics/epic-primitives'
import { EmptyState } from '../../ui/EmptyState'
import { toast } from '../../../state/toast'
import { PhBlock, PhCard } from './ph-primitives'
import { PhAgentTools } from './PhAgentTools'
import { ProjectPagesSection } from './projectpages/ProjectPagesSection'

const EMPTY_JOBS: ScheduleJob[] = []

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

  const snapshots: EpicSnapshots = { sessions, chats, jobs: scheduleJobs, prds }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1080px] px-[34px] py-[26px] text-fg">
        <PhNow cwd={activeTab.cwd} snapshots={snapshots} />
        <PhOpenQuestions cwd={activeTab.cwd} sessions={sessions} chats={chats} />
        <PhAgentTools cwd={activeTab.cwd} />

        <ProjectPagesSection output={output} loaded={loaded} onGenerate={handleGenerate} />
      </div>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectHome = memo(ProjectHomeComponent)
