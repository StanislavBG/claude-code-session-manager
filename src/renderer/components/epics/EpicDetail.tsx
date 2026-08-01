import { useEffect, useRef, useState } from 'react'
import { useChat } from '../../state/chat'
import { usePromptSessions, type PromptSession, type PromptSessionEvent } from '../../state/promptSessions'
import { useScheduleState } from '../../state/scheduleState'
import { useEpicTerminal, type EpicTerminalMode } from '../../state/epicTerminal'
import { EpicTerminalPane } from './EpicTerminalPane'
import { epicDisplayStatus, epicPrds, epicStats, type EpicSnapshots, type EpicPrd } from '../../lib/epicDerive'
import { EpicStatusChip, EpicKindTag } from './epic-primitives'
import { ProjectTag, PrdStatusPill, SchBadge, verdictLabel, type PrdDisplayStatus } from '../tabs/scheduler/sched-primitives'
import { Turn } from '../ChatTranscriptTurn'
import { openPrdSlug } from '../../lib/epicNav'
import { ViewTabs } from '../ui/ViewTabs'
import { AlmanacIcon } from '../layout/AlmanacIcon'
import { RunLogViewer } from '../tabs/plans/RunLogViewer'
import { formatAgo, formatDuration, formatTimingLabel } from '../../lib/formatTime'
import { toast } from '../../state/toast'
import { useScheduledPrds } from '../../lib/useScheduledPrds'
import { useBranch } from '../../lib/useBranch'
import type { ScheduleJob } from '../../../preload/api'

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

// Relative ages per the mock's EMeta ("opened 2 days ago · last activity
// 26m ago") — absolute timestamps read as a log, not an almanac.
function formatWhen(value: string | number): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : formatAgo(d.getTime(), Date.now())
}

/** A PRD file with no matching queue.json job row reads 'draft'
 *  (epicPrds.status carries the raw ScheduleJobStatus otherwise) — map the
 *  one status word STATUS_TONE doesn't key on ('pending') to its Almanac
 *  display name ('queued') rather than forking a second tone table. */
function prdPillStatus(status: EpicPrd['status']): PrdDisplayStatus {
  return status === 'pending' ? 'queued' : (status as PrdDisplayStatus)
}

/** Lazy, cached PRD line count — no field for this on EpicPrd/PrdListItem,
 *  so this reads the file body via schedule.readPrd on first render of each
 *  slug and remembers the result module-wide (cards remount often as the
 *  Epic list re-groups/re-sorts). Absent in test mocks that don't stub
 *  readPrd — guarded, so those cards just render without a line count. */
const prdLineCountCache = new Map<string, number | null>()

function usePrdLineCount(slug: string): number | null {
  const [count, setCount] = useState<number | null>(() => prdLineCountCache.get(slug) ?? null)

  useEffect(() => {
    const cached = prdLineCountCache.get(slug)
    if (cached !== undefined) {
      setCount(cached)
      return
    }
    if (typeof window.api?.schedule?.readPrd !== 'function') return
    let cancelled = false
    window.api.schedule
      .readPrd(slug)
      .then((res) => {
        const lines = res.ok && res.text ? res.text.split('\n').length : null
        prdLineCountCache.set(slug, lines)
        if (!cancelled) setCount(lines)
      })
      .catch(() => {
        prdLineCountCache.set(slug, null)
        if (!cancelled) setCount(null)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  return count
}

function PrdCard({ prd }: { prd: EpicPrd }) {
  const lineCount = usePrdLineCount(prd.slug)
  return (
    <div
      className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-3 rounded-xl border border-line bg-bg-hi p-3.5"
      data-testid="epic-prd-card"
    >
      <span className="mt-0.5 text-accent" aria-hidden="true">
        <AlmanacIcon name="file" size={16} />
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px] font-semibold text-fg">{prd.slug}</span>
          <PrdStatusPill status={prdPillStatus(prd.status)} />
          {lineCount !== null && (
            <span className="font-mono text-[11px] text-fg-faint" data-testid="epic-prd-line-count">
              {lineCount} lines
            </span>
          )}
        </span>
        {prd.title && <span className="mt-1 block text-[12.5px] leading-relaxed text-fg-faint">{prd.title}</span>}
      </span>
      <button
        type="button"
        onClick={() => openPrdSlug(prd.slug)}
        title={`Open PRD "${prd.slug}" in Scheduler`}
        data-testid="epic-prd-open"
        className="inline-flex items-center text-fg-faint hover:text-fg-dim"
      >
        <AlmanacIcon name="arrowright" size={15} />
      </button>
    </div>
  )
}

function RunCard({ job }: { job: ScheduleJob }) {
  const [showLog, setShowLog] = useState(false)
  const startedMs = job.startedAt ? Date.parse(job.startedAt) : null
  const finishedMs = job.finishedAt ? Date.parse(job.finishedAt) : null
  const runtime =
    startedMs !== null && finishedMs !== null
      ? formatTimingLabel(finishedMs - startedMs)
      : startedMs !== null && job.status === 'running'
        ? formatDuration(Date.now() - startedMs)
        : null

  return (
    <div className="grid gap-2 rounded-xl border border-line bg-bg-hi p-3.5" data-testid="epic-run-card">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-[12.5px] font-semibold text-fg">{job.slug}</span>
        <SchBadge status={job.status} />
        {runtime && <span className="font-mono text-[11px] text-fg-faint">{runtime}</span>}
        {job.exitCode !== null && <span className="font-mono text-[11px] text-fg-faint">exit {job.exitCode}</span>}
        {job.verifierVerdict && (
          <span className="font-mono text-[11px] text-fg-faint">{verdictLabel(job.verifierVerdict)}</span>
        )}
        {job.runId && (
          <button
            type="button"
            onClick={() => setShowLog(true)}
            data-testid="epic-run-view-log"
            className="ml-auto text-[11.5px] font-semibold text-fg-dim hover:text-fg"
          >
            View log →
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-3 font-mono text-[11px] text-fg-faint">
        <span>started {startedMs !== null ? formatAgo(startedMs, Date.now()) : '—'}</span>
        <span>finished {finishedMs !== null ? formatAgo(finishedMs, Date.now()) : '—'}</span>
      </div>
      {showLog && job.runId && (
        <RunLogViewer runId={job.runId} slug={job.slug} title={job.title || job.slug} onClose={() => setShowLog(false)} />
      )}
    </div>
  )
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
}

export function EpicDetail({ promptSession }: Props) {
  const epicId = promptSession.id
  const { cwd, claudeSessionId: sessionId } = promptSession
  const isCompleted = promptSession.status === 'completed'

  const chat = useChat((s) => s.chats[epicId])
  const hydrate = useChat((s) => s.hydrate)
  const sessions = usePromptSessions((s) => s.sessions)
  const sessionEvents = usePromptSessions((s) => s.events[epicId]) ?? EMPTY_EVENTS
  const markCompleted = usePromptSessions((s) => s.markCompleted)
  const resumeArchived = usePromptSessions((s) => s.resumeArchived)
  const appendPromptSessionEvent = usePromptSessions((s) => s.appendPromptSessionEvent)
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS

  const mode = useEpicTerminal((s) => s.modes[epicId] ?? 'chat')
  const setMode = useEpicTerminal((s) => s.setMode)
  const setAttached = useEpicTerminal((s) => s.setAttached)

  const [view, setView] = useState<ViewKey>('discussion')
  const prds = useScheduledPrds()
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

  const turns = chat?.turns ?? []
  const running = chat?.running ?? false

  // Merged timeline: chat turns + this Epic's own 'prd_created'/'closed'/
  // 'response' (Terminal-stint marker, PRD 831) audit events, ordered by
  // time — the same timeline construction the retired PromptSessionConversation.tsx used.
  const timeline = [
    ...turns.map((t) => ({ kind: 'turn' as const, at: t.at, turn: t })),
    ...sessionEvents
      .filter((e): e is PromptSessionEvent & { kind: 'prd_created' | 'closed' | 'response' } =>
        e.kind === 'prd_created' || e.kind === 'closed' || e.kind === 'response',
      )
      .map((e) => ({ kind: 'event' as const, at: Date.parse(e.at), event: e })),
  ].sort((a, b) => a.at - b.at)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    // Auto-scroll to bottom on Epic switch, on switching back to Discussion,
    // and as the live stream grows (chat?.stream.length keeps this firing
    // while a turn is still in flight, not just once it lands in `turns`).
  }, [epicId, view, timeline.length, running, chat?.stream.length])

  // Narrow chats snapshot: the derive helpers only index this Epic's own
  // entry, and subscribing to the whole `chats` record would re-render this
  // component on every streaming token of ANY chat (PRD 833 I6).
  const snapshots: EpicSnapshots = { sessions, chats: chat ? { [epicId]: chat } : {}, jobs: scheduleJobs, prds }
  const status = epicDisplayStatus(epicId, snapshots)
  const attachedPrds = epicPrds(epicId, snapshots)
  const stats = epicStats(epicId, snapshots)

  const projectName = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? cwd
  const branch = useBranch(cwd)
  // Job row is the source of truth for Runs (not the PRD join) so a job
  // whose PRD file was later archived still lists.
  const epicRuns = scheduleJobs.filter((j) => j.sourcePromptId === epicId)

  const { title, goal } = splitTitleAndGoal(promptSession.goalText)

  const views: { key: ViewKey; label: string }[] = [
    { key: 'discussion', label: `Discussion ${timeline.length}` },
    { key: 'prds', label: `PRDs ${attachedPrds.length}` },
    { key: 'runs', label: `Runs ${epicRuns.length}` },
  ]

  const onMarkCompleted = () => {
    setMarkingCompleted(true)
    // markCompleted kills the Epic's PTY and chat run; drop the terminal
    // attachment with it so a completed Epic can't leave chat.ts's send()
    // guard latched on a session that no longer exists.
    setAttached(epicId, false)
    setMode(epicId, 'chat')
    void markCompleted(epicId).finally(() => setMarkingCompleted(false))
  }

  // Mutual exclusion: a chatRunner run in flight (or queued behind one) for
  // this Epic must finish before Terminal mode can attach the same
  // claudeSessionId — otherwise a headless resume and an interactive resume
  // would race on the same transcript.
  const chatBusy = running || (chat?.queuedPosition ?? 0) > 0
  const terminalDisabledReason = chatBusy
    ? 'Chat is running or queued for this Epic — wait for it to finish before switching to Terminal.'
    : null

  // Returning to Chat (manual toggle or the pane reporting a PTY exit) records
  // a 'response'-kind marker on the Epic's event chain so the Discussion
  // thread's audit trail stays honest even though the interactive turns
  // themselves are never backfilled (out of scope).
  const returnToChat = () => {
    // Explicit handoff back to Chat is the ONE place a Terminal-mode PTY is
    // torn down by the user (browsing to another Epic no longer kills it, so
    // the session survives). Chat and Terminal are mutually-exclusive views
    // over one claudeSessionId: the interactive claude has to be gone before
    // chatRunner may `--resume` the same session. Idempotent no-op when the
    // PTY already exited on its own.
    window.api.pty.kill(sessionId)
    setAttached(epicId, false)
    // Read the tail fresh rather than off the render-snapshotted
    // `sessionEvents` — appendPromptSessionEvent's tail-chain check needs the
    // CURRENT tail, not whatever was current when EpicDetail last rendered.
    const liveEvents = usePromptSessions.getState().events[epicId] ?? []
    const tail = liveEvents[liveEvents.length - 1] ?? null
    if (tail) {
      appendPromptSessionEvent(epicId, {
        kind: 'response',
        causedByEventId: tail.id,
        text: 'Iterated in Terminal view',
      })
    }
    setMode(epicId, 'chat')
  }

  const onModeChange = (next: EpicTerminalMode) => {
    if (next === mode) return
    if (next === 'terminal') {
      // Re-read the LIVE chat state, not the render snapshot: a run can start
      // between the last render and this click (external send, dequeued
      // ticket, Web Remote prompt) — spawning a PTY then would double-attach
      // the claudeSessionId (PRD 833 I1).
      const live = useChat.getState().chats[epicId]
      const liveBusy = Boolean(live?.running) || (live?.queuedPosition ?? 0) > 0
      if (terminalDisabledReason || liveBusy) {
        toast.info('Chat is running or queued for this Epic — wait for it to finish before switching to Terminal.')
        return
      }
      setMode(epicId, 'terminal')
      return
    }
    returnToChat()
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
              {branch && (
                <span className="font-mono text-xs text-fg-faint" data-testid="epic-detail-branch">
                  ⎇ {branch}
                </span>
              )}
            </div>
            <h1 className="m-0 font-serif text-2xl font-semibold leading-tight text-fg">{title}</h1>
            {goal && <p className="m-0 mt-1.5 max-w-[700px] text-[13.5px] leading-relaxed text-fg-dim">{goal}</p>}
          </div>
          <div className="ml-auto flex shrink-0 gap-1.5">
            {!isCompleted && (
              <div
                className="inline-flex items-center gap-0.5 rounded-md border border-line bg-bg-hi p-0.5"
                data-testid="epic-mode-toggle"
              >
                <button
                  type="button"
                  onClick={() => onModeChange('chat')}
                  aria-pressed={mode === 'chat'}
                  data-testid="epic-mode-chat"
                  className={`rounded px-2.5 py-1 text-xs font-semibold ${mode === 'chat' ? 'bg-bg text-fg shadow-sm' : 'text-fg-faint hover:text-fg-dim'}`}
                >
                  Chat
                </button>
                <button
                  type="button"
                  onClick={() => onModeChange('terminal')}
                  aria-pressed={mode === 'terminal'}
                  disabled={Boolean(terminalDisabledReason)}
                  title={terminalDisabledReason ?? 'Switch to an interactive terminal for this Epic'}
                  data-testid="epic-mode-terminal"
                  className={`rounded px-2.5 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${mode === 'terminal' ? 'bg-bg text-fg shadow-sm' : 'text-fg-faint hover:text-fg-dim'}`}
                >
                  Terminal
                </button>
              </div>
            )}
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
                disabled={markingCompleted || mode === 'terminal'}
                title={mode === 'terminal' ? 'Switch back to Chat before marking this Epic completed — it would kill the live Terminal session.' : undefined}
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
          {stats?.tokens && <MetaItem label="tokens" value={stats.tokens} />}
          {/* The Epic IS this claude session — surface the id so it's
              unambiguous which session scheduler PRDs post their completion
              responses back to (notifyOriginatingTab keys off it). */}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(sessionId).then(
                () => toast.info('Session id copied'),
                () => toast.error('Copy failed'),
              )
            }}
            title={`claude session ${sessionId} — click to copy. Scheduler PRDs dispatched from this Epic post their completion responses back into this session's thread.`}
            data-testid="epic-session-id"
            className="inline-flex items-baseline gap-1.5 text-xs hover:text-fg"
          >
            <span className="text-fg-faint">session</span>
            <span className="font-mono font-semibold text-fg-dim">{sessionId.slice(0, 8)}…</span>
          </button>
        </div>

        {mode === 'chat' && (
          <div className="flex gap-0.5">
            <ViewTabs options={views} active={view} onChange={setView} />
          </div>
        )}
      </header>

      {mode === 'terminal' ? (
        <div className="min-h-0 flex-1" data-testid="epic-terminal-pane-wrap">
          {/* Keyed by sessionId: forces a full unmount/remount when the
           *  selected Epic changes rather than reusing this instance across
           *  two different claudeSessionIds (spawnedRef/exited state assume
           *  a single session's lifetime). */}
          <EpicTerminalPane key={sessionId} epicId={epicId} cwd={cwd} sessionId={sessionId} onReturnToChat={returnToChat} />
        </div>
      ) : (
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
                      sessionId={sessionId}
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
              if (e.kind === 'response') {
                return (
                  <div key={e.id} data-testid="epic-response-event" className="text-center text-[11px] text-fg-faint">
                    — {e.text} —
                  </div>
                )
              }
              return (
                <div key={e.id} data-testid="epic-closed-event" className="text-center text-[11px] text-fg-faint">
                  — Epic marked completed —
                </div>
              )
            })}

            {/* In-flight turn: chat.stream/liveToolUses accumulate on
                chat:run:output/tool-use deltas but never land in `turns`
                until pushTurn fires on complete/error/needs-input — without
                this the whole turn was dead air (PRD 837). Keyed by epicId
                (chat is `chats[epicId]`), so switching Epics swaps in that
                Epic's own in-flight state, never leaking the previous one's
                partial stream. Replaced by the real turn the instant
                pushTurn's single atomic set() flips running:false and
                appends it — no separate teardown step, so no flicker of
                both being on screen together. */}
            {running &&
              (chat && chat.queuedPosition > 0 ? (
                <div
                  key={`epic-live-queued-${epicId}`}
                  data-testid="epic-queued-position"
                  className="text-center text-[11px] text-fg-faint"
                >
                  queued · position {chat.queuedPosition}
                </div>
              ) : (
                <div key={`epic-live-turn-${epicId}`} data-testid="epic-live-turn">
                  <Turn
                    turn={{
                      id: `${epicId}-live`,
                      role: 'assistant',
                      text: chat?.stream ?? '',
                      toolUses: chat?.liveToolUses,
                      at: Date.now(),
                    }}
                    cwd={cwd}
                    tabId={epicId}
                    sessionId={sessionId}
                    runActive
                    consentActionDisabled={running}
                    enableRawSessionActions={false}
                    linkTarget="browser"
                    inlineFilePreview
                    toolStripVariant="collapsible"
                    needsDecisionStyle
                  />
                </div>
              ))}
          </div>
        )}

        {view === 'prds' && (
          <div className="grid max-w-[900px] gap-4" data-testid="epic-prds-placeholder">
            {attachedPrds.length === 0 ? (
              <EmptyPlaceholder text="No PRD yet for this Epic. Ask Claude in the thread — it will attach here." />
            ) : (
              <>
                <div className="grid gap-2">
                  {attachedPrds.map((p) => (
                    <PrdCard key={p.slug} prd={p} />
                  ))}
                </div>
                <p className="m-0 text-[12.5px] leading-relaxed text-fg-faint">
                  Accepting a PRD hands it to the Scheduler as a <span className="font-mono">claude -p</span> job.
                </p>
              </>
            )}
          </div>
        )}

        {view === 'runs' && (
          <div className="grid max-w-[900px] gap-2" data-testid="epic-runs-placeholder">
            {epicRuns.length === 0 ? (
              <EmptyPlaceholder text="No agent runs in this Epic yet." />
            ) : (
              epicRuns.map((j) => <RunCard key={j.slug} job={j} />)
            )}
          </div>
        )}
      </div>
      )}
    </section>
  )
}
