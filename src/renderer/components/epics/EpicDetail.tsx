import { useEffect, useRef, useState } from 'react'
import { useChat } from '../../state/chat'
import { usePromptSessions, type PromptSession, type PromptSessionEvent } from '../../state/promptSessions'
import { useScheduleState } from '../../state/scheduleState'
import { epicDisplayStatus, epicPrds, epicStats, type EpicSnapshots } from '../../lib/epicDerive'
import { EpicStatusChip, EpicKindTag } from './epic-primitives'
import { ProjectTag } from '../tabs/scheduler/sched-primitives'
import { Turn } from '../ChatTranscriptTurn'
import { openPrdSlug } from '../TerminalChat'
import { ViewTabs } from '../ui/ViewTabs'
import type { ScheduleJob, PrdListItem } from '../../../preload/api'

/**
 * Right pane of the redesigned Epics workspace — header (status/kind/project
 * tags, title, goal, actions) + meta row + Discussion/PRDs/Runs view tabs.
 * Built from session-manager-operations/design-mocks/epics/DESIGN_SPEC.md
 * ("Right pane") + epics-mock.jsx's EpicDetail/Turn/ToolStrip, translated
 * from inline styles to Tailwind Almanac tokens.
 *
 * Supersedes PromptSessionConversation.tsx as the Epic conversation surface
 * (that file is retired by PRD 829, not here — keep it compiling until then).
 * The Discussion timeline reuses PromptSessionConversation's own merge logic
 * (chat turns + prd_created/closed events, sorted by time) and the shared
 * Turn renderer from ChatTranscriptTurn.tsx, extended behind two new props
 * (toolStripVariant, needsDecisionStyle) rather than forked.
 *
 * PRDs/Runs tab real content is PRD 828's sibling — this file renders
 * placeholder empty states for both. The composer (827-epic-composer) and
 * New Epic card (827-new-epic-card) are separate wave siblings; this file
 * never renders a composer.
 */

const EMPTY_EVENTS: PromptSessionEvent[] = []
const EMPTY_JOBS: ScheduleJob[] = []
const EMPTY_PRDS: PrdListItem[] = []

type ViewKey = 'discussion' | 'prds' | 'runs'

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-xs" data-testid="epic-meta-item">
      <span className="text-fg-faint">{label}</span>
      <span className="font-mono font-semibold text-fg-dim">{value}</span>
    </span>
  )
}

function EmptyPlaceholder({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-rule px-6 py-8 text-center text-sm leading-relaxed text-fg-faint">
      {text}
    </div>
  )
}

function formatWhen(value: string | number): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

/** NewEpicCard.tsx writes goalText as `${title}\n\n${goal}` (no separate
 *  title field on PromptSession) — split back apart for the header's h1 +
 *  goal paragraph. Older/Epics with no blank-line separator render the
 *  whole text as the title with no goal paragraph. */
function splitTitleAndGoal(goalText: string): { title: string; goal: string } {
  const idx = goalText.indexOf('\n\n')
  if (idx === -1) return { title: goalText, goal: '' }
  return { title: goalText.slice(0, idx), goal: goalText.slice(idx + 2) }
}

/** Latest activity timestamp across the Epic's audit events + chat turns,
 *  falling back to the Epic's own createdAt when neither has fired yet. */
function lastActivityAt(session: PromptSession, events: PromptSessionEvent[], turns: { at: number }[]): number {
  const times = [
    ...events.map((e) => Date.parse(e.at)),
    ...turns.map((t) => t.at),
  ].filter((n) => !Number.isNaN(n))
  if (!times.length) return Date.parse(session.createdAt)
  return Math.max(...times)
}

interface Props {
  promptSession: PromptSession
  /** Navigation to the real terminal/session behind this Epic — the target
   *  itself is wired by PRD 829; this file only surfaces the button/prop. */
  onOpenRawSession?: (epicId: string) => void
}

export function EpicDetail({ promptSession, onOpenRawSession }: Props) {
  const epicId = promptSession.id
  const { cwd, claudeSessionId: sessionId } = promptSession
  const isCompleted = promptSession.status === 'completed'

  const chat = useChat((s) => s.chats[epicId])
  const chats = useChat((s) => s.chats)
  const hydrate = useChat((s) => s.hydrate)
  const sessions = usePromptSessions((s) => s.sessions)
  const sessionEvents = usePromptSessions((s) => s.events[epicId]) ?? EMPTY_EVENTS
  const markCompleted = usePromptSessions((s) => s.markCompleted)
  const resumeArchived = usePromptSessions((s) => s.resumeArchived)
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS

  const [view, setView] = useState<ViewKey>('discussion')
  const [prds, setPrds] = useState<PrdListItem[]>(EMPTY_PRDS)
  const [markingCompleted, setMarkingCompleted] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void hydrate({ tabId: epicId, cwd, sessionId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epicId])

  // Tab state resets to Discussion on every Epic change.
  useEffect(() => {
    setView('discussion')
  }, [epicId])

  useEffect(() => {
    let alive = true
    window.api.schedule
      .listPrds()
      .then((list) => {
        if (alive) setPrds(list)
      })
      .catch(() => {
        if (alive) setPrds(EMPTY_PRDS)
      })
    return () => {
      alive = false
    }
  }, [epicId])

  const turns = chat?.turns ?? []
  const running = chat?.running ?? false

  // Merged timeline: chat turns + this Epic's own 'prd_created'/'closed'
  // audit events, ordered by time — mirrors PromptSessionConversation.tsx's
  // timeline construction verbatim.
  const timeline = [
    ...turns.map((t) => ({ kind: 'turn' as const, at: t.at, turn: t })),
    ...sessionEvents
      .filter((e): e is PromptSessionEvent & { kind: 'prd_created' | 'closed' } =>
        e.kind === 'prd_created' || e.kind === 'closed',
      )
      .map((e) => ({ kind: 'event' as const, at: Date.parse(e.at), event: e })),
  ].sort((a, b) => a.at - b.at)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    // Auto-scroll to bottom on Epic switch and on switching back to Discussion.
  }, [epicId, view, timeline.length])

  const snapshots: EpicSnapshots = { sessions, chats, jobs: scheduleJobs, prds }
  const status = epicDisplayStatus(epicId, snapshots)
  const attachedPrds = epicPrds(epicId, snapshots)
  const stats = epicStats(epicId, snapshots)

  const projectName = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? cwd
  const runsCount = turns.filter((t) => (t.toolUses?.length ?? 0) > 0).length

  const { title, goal } = splitTitleAndGoal(promptSession.goalText)

  const views: { key: ViewKey; label: string }[] = [
    { key: 'discussion', label: `Discussion ${timeline.length}` },
    { key: 'prds', label: `PRDs ${attachedPrds.length}` },
    { key: 'runs', label: `Runs ${runsCount}` },
  ]

  const onMarkCompleted = () => {
    setMarkingCompleted(true)
    void markCompleted(epicId).finally(() => setMarkingCompleted(false))
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg" data-testid="epic-detail">
      <header className="border-b border-line px-5 pt-4">
        <div className="flex items-start gap-3.5">
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2" data-testid="epic-detail-tags">
              <EpicStatusChip status={status} />
              <EpicKindTag kind={promptSession.tag} />
              <ProjectTag cwd={cwd} name={projectName} />
            </div>
            <h1 className="m-0 font-serif text-2xl font-semibold leading-tight text-fg">{title}</h1>
            {goal && <p className="m-0 mt-1.5 max-w-[700px] text-[13.5px] leading-relaxed text-fg-dim">{goal}</p>}
          </div>
          <div className="ml-auto flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => onOpenRawSession?.(epicId)}
              data-testid="epic-open-raw-session"
              className="rounded-md border border-line bg-bg-hi px-3 py-1.5 text-xs font-semibold text-fg-dim hover:bg-hi"
            >
              Open raw session
            </button>
            {isCompleted ? (
              <button
                type="button"
                onClick={() => resumeArchived(epicId)}
                data-testid="epic-resume"
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/90"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={onMarkCompleted}
                disabled={markingCompleted}
                data-testid="epic-mark-completed"
                className="rounded-md border border-line bg-bg-hi px-3 py-1.5 text-xs font-semibold text-fg-dim hover:bg-hi disabled:opacity-50"
              >
                {markingCompleted ? 'Marking…' : 'Mark completed'}
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4 pb-2.5" data-testid="epic-meta">
          <MetaItem label="opened" value={formatWhen(promptSession.createdAt)} />
          <MetaItem label="last activity" value={formatWhen(lastActivityAt(promptSession, sessionEvents, turns))} />
          {stats && <MetaItem label="turns" value={String(stats.turns)} />}
          {stats && <MetaItem label="tool calls" value={String(stats.toolCalls)} />}
        </div>

        <div className="flex gap-0.5">
          <ViewTabs options={views} active={view} onChange={setView} />
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-testid="epic-detail-body">
        {view === 'discussion' && (
          <div className="grid max-w-[900px] gap-4">
            {attachedPrds.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pb-1" data-testid="epic-attached-prds">
                <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint">attached</span>
                {attachedPrds.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    onClick={() => setView('prds')}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-bg-hi px-2.5 py-1 font-mono text-[11px] text-fg-dim hover:bg-hi"
                  >
                    {p.title || p.slug}
                  </button>
                ))}
              </div>
            )}

            {timeline.length === 0 && !running && (
              <div
                className="rounded-xl border border-dashed border-rule px-6 py-8 text-center text-sm leading-relaxed text-fg-faint"
                data-testid="epic-seed-goal"
              >
                {promptSession.goalText}
              </div>
            )}

            {timeline.map((item) => {
              if (item.kind === 'turn') {
                const t = item.turn
                const i = turns.indexOf(t)
                return (
                  <div key={t.id} id={`epic-detail-turn-${t.id}`}>
                    <Turn
                      turn={t}
                      cwd={cwd}
                      tabId={epicId}
                      runActive={running && t.role === 'assistant' && i === turns.length - 1}
                      consentActionDisabled={running}
                      enableRawSessionActions={false}
                      linkTarget="browser"
                      inlineFilePreview
                      toolStripVariant="collapsible"
                      needsDecisionStyle
                    />
                  </div>
                )
              }
              const e = item.event
              if (e.kind === 'prd_created') {
                return (
                  <div key={e.id} data-testid="epic-prd-event" className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => openPrdSlug(e.prdSlug!)}
                      title={`Open PRD "${e.prdSlug}" in Scheduler`}
                      className="rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-accent hover:bg-hi"
                    >
                      → dispatched to PRD #{e.prdSlug}
                    </button>
                  </div>
                )
              }
              return (
                <div key={e.id} data-testid="epic-closed-event" className="text-center text-[11px] text-fg-faint">
                  — Epic marked completed —
                </div>
              )
            })}
          </div>
        )}

        {view === 'prds' && (
          <div className="max-w-[900px]" data-testid="epic-prds-placeholder">
            <EmptyPlaceholder text="PRDs for this Epic will appear here." />
          </div>
        )}

        {view === 'runs' && (
          <div className="max-w-[900px]" data-testid="epic-runs-placeholder">
            <EmptyPlaceholder text="Agent runs for this Epic will appear here." />
          </div>
        )}
      </div>
    </section>
  )
}
