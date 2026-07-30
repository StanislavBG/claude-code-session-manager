import { create } from 'zustand'
import { toast } from './toast'
import { transcriptExists } from '../lib/transcriptExists'
import { classifyPromptTicket } from '../lib/promptClassifier'
import { useSessions } from './sessions'

/**
 * Per-tab chat state for the terminal chat experience (PRD 319). Each tab that
 * is `dormant` (no live PTY — see sessions.ts) drives a headless `claude -p`
 * loop through the main-process chat engine (chatRunner.cjs, PRD 318) over the
 * `window.api.chat.*` IPC surface.
 *
 * Island store: it owns ONLY chat turns + run state, keyed by tabId. It does
 * not cross-subscribe to other stores (sessions/live). The durable transcript
 * already lives in the session JSONL via --session-id; this store is ephemeral.
 *
 * Flow per command:
 *   send() → window.api.chat.run(...) → engine spawns claude -p →
 *   chat:run:started → chat:run:output* → (chat:run:complete | needs-input | error)
 * First command for a tab creates the session (resume:false → --session-id);
 * later commands resume it (resume:true → --resume) so context carries forward.
 */

export type ChatTurnRole = 'user' | 'assistant' | 'question' | 'error' | 'notice'

export interface ToolUseTrace {
  id: string
  kind: 'skill' | 'mcp' | 'tool'
  label: string
}

export interface ChatTurn {
  id: string
  role: ChatTurnRole
  /** Rendered text. For a question turn, the joined prompt; questions[] holds the items. */
  text: string
  questions?: string[]
  at: number
  /** Tools/skills/MCP calls that fired while producing this turn (assistant turns only). */
  toolUses?: ToolUseTrace[]
}

/**
 * A user prompt submitted while a tab's turn is already running. Queued
 * client-side (chat.ts) and dispatched one at a time through the same
 * chatRunner FIFO lane a fresh manual send uses — never a second queue.
 */
export interface PromptTicket {
  id: string
  tabId: string
  sessionId: string
  cwd: string
  text: string
  status: 'queued' | 'running' | 'dispatched-to-prd' | 'done' | 'failed' | 'needs-input'
  createdAt: number
  startedAt?: number
  completedAt?: number
  prdSlugs?: string[]
  /** For a 'needs-input' ticket: the id of the question ChatTurn it corresponds to, so the panel can scroll/highlight it. */
  questionTurnId?: string
  /** User-selected composer tag (PRD 774) — deterministic, never LLM-classified.
   *  Threaded into the PRD's frontmatter when this ticket dispatches to /develop. */
  tag?: 'feature' | 'bug'
}

interface TabChat {
  turns: ChatTurn[]
  /** A run is in flight OR waiting in the queue — input is disabled. */
  running: boolean
  /** 1-based queue position while waiting behind a busy lane; 0 when active/idle. */
  queuedPosition: number
  /** The session has been created at least once → subsequent sends resume it. */
  started: boolean
  /** Live streamed assistant text for the in-flight run (replaced by finalMessage on complete). */
  stream: string
  /** Tool/skill/MCP calls accumulated for the in-flight run (mirrors `stream`). */
  liveToolUses: ToolUseTrace[]
  /** Prompts submitted while `running` was true, FIFO — dispatched one at a time on completion. */
  queue: PromptTicket[]
  /**
   * The ticket currently dequeued and in flight — 'queued' while its
   * classification round-trip is pending, 'running' once dispatched inline.
   * null/undefined when idle, or when the active run is a fresh manual
   * send() that never went through the queue (no ticket to represent it).
   * Finalization (pushTurn/applyError) assumes chatRunner's per-tab
   * concurrency-1 lane: no event for a later ticket can arrive before this
   * one's terminal event, so tabId alone is enough to identify which ticket
   * a completion/error belongs to.
   */
  activeTicket?: PromptTicket | null
  /**
   * Terminal-status tickets (done/failed/dispatched-to-prd), oldest first,
   * capped at TICKET_HISTORY_CAP — keeps a ticket visible through its full
   * lifecycle for the chat queue panel (PRD 750) instead of vanishing the
   * moment it's dispatched or completes.
   */
  ticketHistory?: PromptTicket[]
}

interface ChatState {
  chats: Record<string, TabChat>
  /** Tabs for which history hydration has been attempted (exactly once per tab). */
  hydratedTabs: Record<string, true>
  /** Read (or lazily create) the chat slice for a tab. */
  get: (tabId: string) => TabChat
  /** Submit a user command for a tab. sessionId is the tab's sessionId. */
  send: (args: { tabId: string; sessionId: string; cwd: string; prompt: string; tag?: 'feature' | 'bug' }) => void
  /** Reset a tab's chat thread: clears turns and run state (paired with sessions.newSession). */
  resetThread: (tabId: string) => void
  /**
   * Push an ephemeral, in-session-only notice turn (e.g. a slash-nav shortcut
   * acknowledgment). Does NOT touch running/stream/liveToolUses and is never
   * persisted via recordExchange — mirrors the IPC-driven applyNotice below.
   */
  pushNotice: (tabId: string, message: string) => void
  /**
   * One-shot: load prior exchanges from the durable store and prepend them as
   * history turns. No-ops if already called for this tabId, if there are no
   * prior exchanges, or if the exchanges API is unavailable.
   */
  hydrate: (args: { tabId: string; cwd: string; sessionId: string }) => Promise<void>
}

const EMPTY: TabChat = {
  turns: [],
  running: false,
  queuedPosition: 0,
  started: false,
  stream: '',
  liveToolUses: [],
  queue: [],
  activeTicket: null,
  ticketHistory: [],
}

// Bounds ticketHistory's growth for a long-lived tab — the panel only ever
// needs the recent tail, not an unbounded audit log.
const TICKET_HISTORY_CAP = 20

function appendTicketHistory(history: PromptTicket[], ticket: PromptTicket): PromptTicket[] {
  const next = [...history, ticket]
  return next.length > TICKET_HISTORY_CAP ? next.slice(next.length - TICKET_HISTORY_CAP) : next
}

let seq = 0
function turnId(): string {
  seq += 1
  return `t${Date.now().toString(36)}-${seq}`
}

const PRD_TITLE_MAX_LEN = 60

/** First ~60 chars of a ticket's text, trimmed at a word boundary — a mechanical
 *  title for the draft PRD, not real authoring (see dequeueNext's 'develop' branch). */
function deriveTitleFromTicketText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= PRD_TITLE_MAX_LEN) return trimmed
  const cut = trimmed.slice(0, PRD_TITLE_MAX_LEN)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
}

export const useChat = create<ChatState>((set, get) => ({
  chats: {},
  hydratedTabs: {},
  get: (tabId) => get().chats[tabId] ?? EMPTY,
  hydrate: async ({ tabId, cwd, sessionId }) => {
    // Idempotent: one-shot per tab regardless of outcome.
    if (get().hydratedTabs[tabId]) return
    set({ hydratedTabs: { ...get().hydratedTabs, [tabId]: true } })

    if (typeof window === 'undefined' || !window.api?.exchanges) return

    try {
      const exchanges = await window.api.exchanges.list({ cwd, sessionId })
      if (!exchanges.length) return

      // API returns newest-first; reverse to chronological for display.
      const historyTurns: ChatTurn[] = []
      for (const ex of [...exchanges].reverse()) {
        const at = new Date(ex.ts).getTime()
        historyTurns.push({ id: turnId(), role: 'user', text: ex.prompt, at })
        historyTurns.push({ id: turnId(), role: 'assistant', text: ex.result, at })
      }

      const cur = get().chats[tabId] ?? EMPTY
      set({
        chats: {
          ...get().chats,
          [tabId]: {
            ...cur,
            // Prepend history before any live turns already in the store.
            turns: [...historyTurns, ...cur.turns],
            started: true,
          },
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.api?.logs?.write('chat', 'warn', `exchange hydration failed for tab ${tabId}: ${msg}`)
    }
  },
  send: ({ tabId, sessionId, cwd, prompt, tag }) => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const cur = get().chats[tabId] ?? EMPTY
    if (cur.running) {
      // A turn is already in flight (or queued behind one) — queue this
      // prompt instead of dropping it. dequeueNext() dispatches it, in FIFO
      // order, once the current turn completes.
      const ticket: PromptTicket = {
        id: crypto.randomUUID(),
        tabId,
        sessionId,
        cwd,
        text: trimmed,
        status: 'queued',
        createdAt: Date.now(),
        tag,
      }
      set({
        chats: {
          ...get().chats,
          [tabId]: { ...cur, queue: [...cur.queue, ticket] },
        },
      })
      return
    }
    // A fresh send resumes the tab's session regardless of any outstanding
    // needs-input ticket (chatRunner always resumes by sessionId) — so this
    // reply IS the answer. Clear the stale needs-input marker before
    // dispatching so the queue panel/composer stop treating the tab as
    // stalled once the reply is in flight.
    clearNeedsInput(tabId)
    dispatchSend({ tabId, sessionId, cwd, text: trimmed, tag })
  },
  resetThread: (tabId) => {
    set({
      chats: {
        ...get().chats,
        [tabId]: { ...EMPTY },
      },
    })
  },
  pushNotice: (tabId, message) => {
    applyNotice(tabId, '', message)
  },
}))

// ─── internal mutators driven by IPC events ────────────────────────────────

function patch(tabId: string, fn: (c: TabChat) => TabChat): void {
  const cur = useChat.getState().chats[tabId] ?? EMPTY
  useChat.setState({ chats: { ...useChat.getState().chats, [tabId]: fn(cur) } })
}

function pushTurn(
  tabId: string,
  turn: ChatTurn,
  extra: Partial<TabChat> = {},
  ticketStatus: 'done' | 'needs-input' = 'done',
  ticketExtra: Partial<PromptTicket> = {},
): void {
  patch(tabId, (c) => {
    const ticketHistory = c.activeTicket
      ? appendTicketHistory(c.ticketHistory ?? [], {
          ...c.activeTicket,
          status: ticketStatus,
          completedAt: Date.now(),
          ...ticketExtra,
        })
      : (c.ticketHistory ?? [])
    return {
      ...c,
      turns: [...c.turns, { ...turn, toolUses: c.liveToolUses }],
      running: false,
      queuedPosition: 0,
      stream: '',
      liveToolUses: [],
      activeTicket: null,
      ticketHistory,
      ...extra,
    }
  })
  dequeueNext(tabId)
}

/**
 * Clears any ticket left in the 'needs-input' state for a tab, folding it
 * back to 'done' — called from the start of a fresh send() (the reply that
 * answers the stalled run) so the queue panel/composer stop treating the tab
 * as stalled once the answer is in flight. A no-op if none is outstanding.
 */
function clearNeedsInput(tabId: string): void {
  patch(tabId, (c) => {
    const history = c.ticketHistory ?? []
    if (!history.some((t) => t.status === 'needs-input')) return c
    return {
      ...c,
      ticketHistory: history.map((t) => (t.status === 'needs-input' ? { ...t, status: 'done' } : t)),
    }
  })
}

/**
 * Push a user turn and hand the prompt to chatRunner — the single path both
 * a fresh manual send() and a dequeued PromptTicket run through, so a queued
 * prompt executes exactly like an immediate one. `promptId` is set only when
 * this dispatch originated from a queued ticket (undefined for a fresh
 * manual send with no ticket) — threaded through to recordExchange.
 *
 * Every dispatch — fresh or dequeued — is represented by an `activeTicket` so
 * the queue panel has something to show for the in-flight turn even when
 * it's the only one. dequeueNext() already installs its own 'running' ticket
 * as activeTicket before calling here (chat.ts:298+), so `cur.activeTicket`
 * is reused when present; a fresh send() has none yet, so one is minted here.
 */
function dispatchSend(args: { tabId: string; sessionId: string; cwd: string; text: string; promptId?: string; tag?: 'feature' | 'bug' }): void {
  const { tabId, sessionId, cwd, text, promptId, tag } = args
  const cur = useChat.getState().chats[tabId] ?? EMPTY
  const userTurn: ChatTurn = { id: turnId(), role: 'user', text, at: Date.now() }
  const activeTicket: PromptTicket = cur.activeTicket ?? {
    id: promptId ?? crypto.randomUUID(),
    tabId,
    sessionId,
    cwd,
    text,
    status: 'running',
    createdAt: Date.now(),
    startedAt: Date.now(),
    tag,
  }
  useChat.setState({
    chats: {
      ...useChat.getState().chats,
      [tabId]: { ...cur, turns: [...cur.turns, userTurn], running: true, queuedPosition: 0, stream: '', activeTicket },
    },
  })
  // Durable resume-vs-create decision: check the on-disk transcript (same
  // check the raw session uses) instead of the ephemeral `started` flag,
  // which goes stale across an app reload and produced the "Session ID
  // <uuid> is already in use" error on the first send after restart.
  transcriptExists(cwd, sessionId)
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      window.api?.logs?.write('chat', 'warn', `transcript-exists check failed for tab ${tabId}: ${msg}`)
      return cur.started
    })
    .then((resume) => window.api.chat.run({ tabId, sessionId, prompt: text, cwd, resume, promptId }))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      applyError(tabId, sessionId, msg)
    })
}

/**
 * Dequeue the oldest queued ticket (if any), FIFO. Runs classification
 * immediately as the ticket reaches the front of the queue — an in-session
 * judgment call, not a scheduled hop (see promptClassifier.ts) — then either
 * dispatches it inline through chatRunner or authors a mechanical draft PRD
 * from the ticket text and moves on to the next queued ticket.
 */
function dequeueNext(tabId: string): void {
  const cur = useChat.getState().chats[tabId] ?? EMPTY
  if (cur.queue.length === 0) return
  const [next, ...rest] = cur.queue
  // `running` must stay true across the classification round-trip (it can
  // take seconds — a real claude -p spawn, up to CLASSIFY_TIMEOUT_MS on
  // failure) so a manual send() during that window queues behind this
  // ticket instead of reading running:false and racing a second dispatch
  // for the same tabId, which chatRunner's per-tab exclusivity guard would
  // then silently drop. `activeTicket` mirrors that in-flight ticket so the
  // queue panel can show it (status still 'queued' during classification).
  patch(tabId, (c) => ({ ...c, queue: rest, running: true, queuedPosition: 0, activeTicket: next }))

  classifyPromptTicket(next.text).then((verdict) => {
    if (verdict === 'develop') {
      dispatchToPrd(tabId, next)
      return
    }
    const running: PromptTicket = { ...next, status: 'running', startedAt: Date.now() }
    patch(tabId, (c) => ({ ...c, activeTicket: running }))
    dispatchSend({ tabId: running.tabId, sessionId: running.sessionId, cwd: running.cwd, text: running.text, promptId: running.id, tag: running.tag })
  })
}

/**
 * Authors a mechanical, templated draft PRD from a ticket's raw text (not a
 * real decomposition — the user reviews/edits the draft in the Scheduler
 * tab's PRD editor before it runs; see PRD implementation notes) and
 * transitions the ticket to 'dispatched-to-prd' with prdSlugs populated on
 * success, or 'failed' with a notice turn on failure.
 */
function dispatchToPrd(tabId: string, ticket: PromptTicket): void {
  const failPrd = (message: string): void => {
    patch(tabId, (c) => ({
      ...c,
      running: false,
      queuedPosition: 0,
      activeTicket: null,
      ticketHistory: appendTicketHistory(c.ticketHistory ?? [], { ...ticket, status: 'failed', completedAt: Date.now() }),
    }))
    applyNotice(tabId, ticket.sessionId, message)
    toast.error(message)
    dequeueNext(tabId)
  }

  window.api.chat
    .createPrd({
      title: deriveTitleFromTicketText(ticket.text),
      cwd: ticket.cwd,
      estimateMinutes: 15,
      goal: ticket.text,
      acceptanceCriteria: [
        'Implement the request described in Goal.',
        'timeout 300 npm run typecheck passes',
      ],
      implementationNotes: `Target project: ${ticket.cwd}`,
      sourcePromptId: ticket.id,
      sourceTabId: ticket.tabId,
      tag: ticket.tag,
    })
    .then((result) => {
      if (!result?.ok) {
        failPrd(`→ PRD authoring failed for ticket ${ticket.id}: ${result?.error ?? 'unknown error'}`)
        return
      }
      const filename = result.filename
      const slug = filename.endsWith('.md') ? filename.slice(0, -3) : filename
      const dispatched: PromptTicket = { ...ticket, status: 'dispatched-to-prd', completedAt: Date.now(), prdSlugs: [slug] }
      applyNotice(tabId, dispatched.sessionId, `→ dispatched to PRD ${filename} (ticket ${dispatched.id})`)
      patch(tabId, (c) => ({
        ...c,
        running: false,
        queuedPosition: 0,
        activeTicket: null,
        ticketHistory: appendTicketHistory(c.ticketHistory ?? [], dispatched),
      }))
      dequeueNext(tabId)
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      failPrd(`→ PRD authoring failed for ticket ${ticket.id}: ${msg}`)
    })
}

function applyError(tabId: string, _sessionId: string, message: string): void {
  // Finalize the in-flight ticket as 'failed' before pushTurn's own (generic,
  // 'done') finalization runs — pushTurn sees activeTicket already cleared
  // and no-ops, so the ticket lands in history exactly once.
  patch(tabId, (c) => {
    if (!c.activeTicket) return c
    return {
      ...c,
      activeTicket: null,
      ticketHistory: appendTicketHistory(c.ticketHistory ?? [], { ...c.activeTicket, status: 'failed', completedAt: Date.now() }),
    }
  })
  pushTurn(tabId, { id: turnId(), role: 'error', text: message, at: Date.now() })
  toast.error(message)
}

// Not a terminal event — the run may still legitimately reach complete/error
// afterward, so this must NOT touch running/stream/liveToolUses (unlike pushTurn).
function applyNotice(tabId: string, _sessionId: string, message: string): void {
  patch(tabId, (c) => ({
    ...c,
    turns: [...c.turns, { id: turnId(), role: 'notice', text: message, at: Date.now() }],
  }))
}

// ─── one-time global IPC subscription ──────────────────────────────────────
// Wired at module load (like live.ts subscribes to transcript events). Guarded
// so a non-renderer import (tests) doesn't throw on a missing window.api.

if (typeof window !== 'undefined' && window.api?.chat) {
  window.api.chat.onQueued(({ tabId, position }) => {
    patch(tabId, (c) => ({ ...c, running: true, queuedPosition: position }))
  })
  window.api.chat.onRunStarted(({ tabId }) => {
    patch(tabId, (c) => ({ ...c, running: true, started: true, queuedPosition: 0, stream: '', liveToolUses: [] }))
  })
  window.api.chat.onOutput(({ tabId, delta }) => {
    patch(tabId, (c) => ({ ...c, stream: c.stream + delta }))
  })
  window.api.chat.onToolUse(({ tabId, id, kind, label }) => {
    patch(tabId, (c) => ({ ...c, liveToolUses: [...c.liveToolUses, { id, kind, label }] }))
  })
  window.api.chat.onComplete(({ tabId, finalMessage }) => {
    pushTurn(tabId, { id: turnId(), role: 'assistant', text: finalMessage, at: Date.now() })
  })
  window.api.chat.onNeedsInput(({ tabId, questions, answerBody }) => {
    const questionTurnId = turnId()
    if (answerBody && answerBody.trim()) {
      // Two turns: the answer body renders as a normal assistant bubble
      // (with the run's accumulated tool-use trace), the question card
      // beneath it carries no tool-use trace of its own.
      patch(tabId, (c) => ({
        ...c,
        turns: [
          ...c.turns,
          { id: turnId(), role: 'assistant', text: answerBody, at: Date.now(), toolUses: c.liveToolUses },
        ],
        liveToolUses: [],
      }))
      pushTurn(
        tabId,
        {
          id: questionTurnId,
          role: 'question',
          text: questions.join('\n'),
          questions,
          at: Date.now(),
        },
        {},
        'needs-input',
        { questionTurnId },
      )
      return
    }
    pushTurn(
      tabId,
      {
        id: questionTurnId,
        role: 'question',
        text: questions.join('\n'),
        questions,
        at: Date.now(),
      },
      {},
      'needs-input',
      { questionTurnId },
    )
  })
  window.api.chat.onError(({ tabId, sessionId, message }) => {
    applyError(tabId, sessionId, message)
  })
  window.api.chat.onNotice(({ tabId, sessionId, message }) => {
    applyNotice(tabId, sessionId, message)
  })
  // External caller (Web Remote / admin HTTP route / MCP tool, PRD 753)
  // pushing a prompt into an open tab's queue from outside the renderer.
  // Resolves the tab's live sessionId/cwd from useSessions and hands off to
  // the SAME send() path a manual composer submit uses — no separate queuing
  // logic. No-ops (with a log line) if the tab isn't open.
  window.api.chat.onExternalSend(({ tabId, prompt }) => {
    const tab = useSessions.getState().tabs.find((t) => t.id === tabId)
    if (!tab) {
      window.api?.logs?.write('chat', 'warn', `external send ignored: tab ${tabId} is not open`)
      return
    }
    useChat.getState().send({ tabId, sessionId: tab.sessionId, cwd: tab.cwd, prompt })
  })
}
