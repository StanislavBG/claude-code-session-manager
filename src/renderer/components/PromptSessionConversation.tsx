import { useEffect, useRef, useState } from 'react'
import { useChat } from '../state/chat'
import { usePromptSessions, type PromptSession, type PromptSessionEvent } from '../state/promptSessions'
import { useScheduleState } from '../state/scheduleState'
import { Turn } from './ChatTranscriptTurn'
import { openPrdSlug } from './TerminalChat'
import { EpicComposer, canCompose } from './epics/EpicComposer'
import type { EpicSnapshots } from '../lib/epicDerive'
import type { PrdListItem, ScheduleJob } from '../../preload/api'

// Stable fallback for the snapshots.prds slice below — EpicComposer only
// needs epicDisplayStatus (sessions/chats/jobs), never the PRD list itself,
// so an empty constant avoids minting a fresh array per render (zustand
// selector-stability rule).
const EMPTY_PRDS: PrdListItem[] = []
const EMPTY_JOBS: ScheduleJob[] = []

/**
 * Assistant-turn ids already folded into a 'response' PromptSessionEvent, per
 * promptSessionId — module-level (not a component ref) because this view can
 * unmount/remount for the same PromptSession (e.g. "Back to Projects" then
 * reopening the same row) while the underlying chat.ts turns persist in its
 * store. A component-local ref would forget it already responded to the same
 * turn on remount and double-append. Mirrors chat.ts's own `hydratedTabs`
 * one-shot-per-key guard, just kept local to this file since it's private to
 * this event-chaining concern.
 */
const respondedTurnIds = new Map<string, Set<string>>()

// Stable fallback for the sessionEvents selector below — an inline `?? []`
// would mint a fresh array every getSnapshot call, which useSyncExternalStore
// treats as a changed snapshot (React #185 / blank-app risk, per this repo's
// zustand-selector-stability rule).
const EMPTY_EVENTS: PromptSessionEvent[] = []

// Deterministic per-Epic identity color, keyed off the Epic's own id (not its
// goal text, which can be edited/reused) — same palette-hash approach as the
// project-dot palette in sched-primitives.tsx, kept local since this is the
// only place an Epic needs a visual identity badge.
const EPIC_BADGE_PALETTE = ['#b8895a', '#6f9e7a', '#7a8fb8', '#b87a9e', '#8fa63f', '#c2874a']
function epicBadgeColor(epicId: string): string {
  let hash = 0
  for (let i = 0; i < epicId.length; i++) hash = (hash * 31 + epicId.charCodeAt(i)) | 0
  return EPIC_BADGE_PALETTE[Math.abs(hash) % EPIC_BADGE_PALETTE.length]
}
function epicInitial(goalText: string): string {
  return (goalText.trim()[0] ?? 'E').toUpperCase()
}

/**
 * Dedicated conversation view for a single PromptSession (PRD 802/803) — a
 * goal-scoped Agent conversation, NOT a top-level SessionTab. Reuses
 * TerminalChat.tsx's composer/transcript machinery (chatRunner send/receive
 * via useChat, markdown turn rendering via ChatTranscriptTurn's Turn) but
 * renders no ChatSessionRail/right-nav — the composer and transcript ARE the
 * whole view (per explicit user direction: "no Right Nav in Terminal going
 * forward").
 *
 * The chat store (chat.ts) is keyed by an opaque string, not by an actual
 * SessionTab id — chatRunner.cjs (main process) never validates that key
 * against a live tab, so this view safely reuses the SAME store/IPC wiring
 * keyed on the PromptSession's own id, with sessionId set to the
 * PromptSession's independently-minted claudeSessionId (never a SessionTab's
 * sessionId).
 */
interface Props {
  promptSession: PromptSession
}

export function PromptSessionConversation({ promptSession }: Props) {
  const chatKey = promptSession.id
  const { cwd, claudeSessionId: sessionId } = promptSession

  const chat = useChat((s) => s.chats[chatKey])
  const hydrate = useChat((s) => s.hydrate)
  const appendPromptSessionEvent = usePromptSessions((s) => s.appendPromptSessionEvent)
  const sessionEvents = usePromptSessions((s) => s.events[promptSession.id]) ?? EMPTY_EVENTS

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const allSessions = usePromptSessions((s) => s.sessions)
  const allChats = useChat((s) => s.chats)
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const snapshots: EpicSnapshots = { sessions: allSessions, chats: allChats, jobs: scheduleJobs, prds: EMPTY_PRDS }

  useEffect(() => {
    void hydrate({ tabId: chatKey, cwd, sessionId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey])

  const turns = chat?.turns ?? []
  const running = chat?.running ?? false
  const stream = chat?.stream ?? ''
  const queuedPosition = chat?.queuedPosition ?? 0

  // Interleave the PromptSession's own 'prd_created'/'closed' audit events
  // into the turn transcript, ordered by time — so an Epic's conversation
  // shows every PRD it spawned (and its closure) inline, traceable in
  // context, not just in a separate side panel. 'prompt' (the session's own
  // opening goal) and 'response' events are NOT re-rendered here: they're
  // already covered by the empty-state message and the turn list itself.
  const timeline = [
    ...turns.map((t) => ({ kind: 'turn' as const, at: t.at, turn: t })),
    ...sessionEvents
      .filter((e): e is PromptSessionEvent & { kind: 'prd_created' | 'closed' } =>
        e.kind === 'prd_created' || e.kind === 'closed',
      )
      .map((e) => ({ kind: 'event' as const, at: Date.parse(e.at), event: e })),
  ].sort((a, b) => a.at - b.at)

  // Fold each newly-completed assistant turn into the PromptSession's own
  // audit chain as a 'response' event, chained off whatever the session's
  // current tail event is (the initial goal 'prompt' event on the first
  // reply, or the prior 'response' event on later ones).
  useEffect(() => {
    const last = turns[turns.length - 1]
    if (!last || last.role !== 'assistant' || running) return
    const responded = respondedTurnIds.get(promptSession.id) ?? new Set<string>()
    if (responded.has(last.id)) return
    responded.add(last.id)
    respondedTurnIds.set(promptSession.id, responded)
    const tail = usePromptSessions.getState().events[promptSession.id]?.slice(-1)[0]
    if (!tail) return
    appendPromptSessionEvent(promptSession.id, {
      kind: 'response',
      causedByEventId: tail.id,
      text: last.text,
    })
  }, [turns, running, promptSession.id, appendPromptSessionEvent])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, stream])

  const prdCount = sessionEvents.filter((e) => e.kind === 'prd_created').length
  const badgeColor = epicBadgeColor(promptSession.id)
  const projectName = cwd.split('/').filter(Boolean).pop() ?? cwd

  return (
    <div className="flex h-full w-full flex-col bg-bg" data-testid="prompt-session-conversation">
      {/* Epic context header — every surface below (agent turns, composer) reads
          as "this Epic's conversation," never a generic chat, per the domain
          model: TAB → EPIC → PRD. */}
      <div className="flex items-center gap-3 border-b border-rule px-4 py-2.5" data-testid="epic-context-header">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md font-serif text-[13px] font-semibold text-white"
          style={{ backgroundColor: badgeColor }}
          title={`Epic ${promptSession.id}`}
        >
          {epicInitial(promptSession.goalText)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[10.5px] uppercase tracking-wide text-fg-faint">
            {projectName} · Epic
          </div>
          <div className="font-serif text-base text-fg truncate" title={promptSession.goalText}>
            {promptSession.goalText}
          </div>
        </div>
        {prdCount > 0 && (
          <span
            className="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-fg-dim"
            title={`${prdCount} PRD(s) dispatched from this Epic`}
          >
            {prdCount} PRD{prdCount === 1 ? '' : 's'} dispatched
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        data-testid="prompt-session-transcript"
      >
        {turns.length === 0 && !running && (
          <div className="flex h-full items-center justify-center text-sm text-fg-faint select-none">
            Send a message to work this goal.
          </div>
        )}
        {timeline.map((item) => {
          if (item.kind === 'turn') {
            const t = item.turn
            const i = turns.indexOf(t)
            const body = (
              <Turn
                turn={t}
                cwd={cwd}
                tabId={chatKey}
                runActive={running && t.role === 'assistant' && i === turns.length - 1}
                consentActionDisabled={running}
                enableRawSessionActions={false}
                linkTarget="browser"
                inlineFilePreview
              />
            )
            // Agent replies carry the Epic's own identity badge — never a
            // generic assistant avatar — so it's unmistakable which Epic's
            // conversation produced this response.
            if (t.role !== 'assistant') {
              return (
                <div key={t.id} id={`prompt-session-turn-${t.id}`} className="rounded-[14px]">
                  {body}
                </div>
              )
            }
            return (
              <div
                key={t.id}
                id={`prompt-session-turn-${t.id}`}
                className="flex items-start gap-2 rounded-[14px]"
                data-testid="epic-assistant-turn"
              >
                <div
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
                  style={{ backgroundColor: badgeColor }}
                  title={`Response in "${promptSession.goalText}"`}
                >
                  {epicInitial(promptSession.goalText)}
                </div>
                <div className="min-w-0 flex-1">{body}</div>
              </div>
            )
          }
          const e = item.event
          if (e.kind === 'prd_created') {
            return (
              <div key={e.id} data-testid="prompt-session-prd-event" className="flex justify-center">
                <button
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
            <div
              key={e.id}
              data-testid="prompt-session-closed-event"
              className="text-center text-[11px] text-fg-faint"
            >
              — Epic marked completed —
            </div>
          )
        })}
        {running && (
          <div className="max-w-[90%]">
            <div className="rounded-lg bg-elev px-3 py-2 text-sm text-fg-dim">
              {queuedPosition > 0 ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-butter" />
                  queued · #{queuedPosition} — waiting for a free run slot
                </span>
              ) : stream ? (
                <span className="whitespace-pre-wrap">{stream}</span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                  running…
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {canCompose(promptSession) && <EpicComposer epic={promptSession} snapshots={snapshots} />}
    </div>
  )
}
