/**
 * ProjectHome — the hosted Project Home document for the active project
 * (NavKey `project-home`). Per Epic "Project Home Layout": the page's
 * primary content is the generated (or shipped-default) `home.html`
 * document, displayed via the same sandboxed iframe ProjectPagesSection
 * already uses, with a single "Generate My Project Home" action above it.
 * A thin live strip (PhNow / PhOpenQuestions) sits above the document —
 * those two show state that changes underneath a static document, so they
 * stay live React rather than being folded into the generated HTML. The
 * synthesized purpose/what/areas/scope/conventions blocks this file used to
 * hand-render are now the `brief` lens (ProjectPagesSection), generated
 * from the same `ProjectBrief` data instead of drawn twice.
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
import { HtmlFrame } from './projectpages/HtmlFrame'
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
    <PhBlock kicker="now" title="What is in flight" note="Live from the Epic queue — this block is never hand-written.">
      {cards.length === 0 ? (
        <p className="text-xs text-fg-faint">No Epics in flight.</p>
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

        {loaded && output?.home && (
          <PhCard className="overflow-hidden mb-7" style={{ height: 'calc(100vh - 380px)', minHeight: 480 }}>
            <HtmlFrame title="Project Home" html={output.home} />
          </PhCard>
        )}

        <ProjectPagesSection output={output} loaded={loaded} />
      </div>
    </div>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const ProjectHome = memo(ProjectHomeComponent)
