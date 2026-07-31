import { create } from 'zustand'
import { toast } from './toast'
import { transcriptExists } from '../lib/transcriptExists'
import { classifyPromptTicket } from '../lib/promptClassifier'
import { isDiscussionTag, type TicketTag } from '../lib/ticketDisplay'
import { useSessions } from './sessions'
import { usePromptSessions } from './promptSessions'

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
  tag?: TicketTag
  /**
   * Set when the user explicitly chose "Continue: <open item>" in the
   * composer's chain picker (PRD 775) instead of "New item". Holds the id of
   * the ROOT ticket whose chain this prompt continues — distinct from this
   * ticket's own `id`. When this ticket is later classified 'develop' and
   * dispatched, the PRD payload's sourcePromptId is `chainRootId` (not
   * `id`), and the resulting PRD slug is appended to the ROOT ticket's
   * prdSlugs, not this ticket's. Never set for a "New item" choice.
   */
  chainRootId?: string
  /**
   * Set once this ticket (or, for a continuation, its chain root) has minted
   * a real PromptSession (promptSessions.ts) and dispatched to a PRD — the
   * PromptSession's own `id`, passed to chat:create-prd as `sourcePromptId`
   * so a later deep link (PRD 807) has something real to resolve to. Unset
   * until dispatchToPrd() actually runs (classification/queueing may still
   * fail before that point).
   */
  promptSessionId?: string
  /**
   * Set when this ticket originated from an external source (Web Remote,
   * admin HTTP route, MCP tool, or the scheduler's own completion
   * notifications — see chatRunner.cjs's enqueueExternalPrompt) rather than
   * a human typing into the composer. External tickets MUST skip
   * classifyPromptTicket entirely in dequeueNext() and are always dispatched
   * inline — they were never a feature request, so they must never reach
   * dispatchToPrd()/chat:create-prd.
   */
  external?: boolean
}

/** Minimal job-status shape a chain-resolution check needs — kept structural
 *  (not importing ScheduleJob from preload/api) so chat.ts stays free of a
 *  cross-store dependency; callers pass scheduleState's jobs array directly. */
export interface ChainJobStatus {
  slug: string
  status: string
}

/**
 * A dispatched-to-prd ticket's chain counts as resolved once every slug in
 * its prdSlugs has scheduler job status 'completed' — read from the
 * scheduler's own job list (scheduleState.ts), never a second polling
 * mechanism. A chain with no PRD slugs yet is not resolved (nothing to
 * offer as "done" — and it wouldn't be a chain to continue either).
 */
export function isChainResolved(ticket: PromptTicket, jobs: ChainJobStatus[]): boolean {
  const slugs = ticket.prdSlugs ?? []
  if (slugs.length === 0) return false
  return slugs.every((slug) => jobs.find((j) => j.slug === slug)?.status === 'completed')
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
  /**
   * A voice transcript recognized while this tab is dormant (no PTY to
   * pty.write into) — set by voice.ts's onFinal, consumed once by
   * TerminalChat's composer (appended into its local draft, then cleared)
   * and/or read by voice.ts's armSubmit at auto-submit time.
   */
  pendingVoiceText?: string
}

interface ChatState {
  chats: Record<string, TabChat>
  /** Tabs for which history hydration has been attempted (exactly once per tab). */
  hydratedTabs: Record<string, true>
  /** Read (or lazily create) the chat slice for a tab. */
  get: (tabId: string) => TabChat
  /** Submit a user command for a tab. sessionId is the tab's sessionId. */
  send: (args: {
    tabId: string
    sessionId: string
    cwd: string
    prompt: string
    tag?: TicketTag
    /** Set when the composer's chain picker (PRD 775) chose "Continue: <open item>". */
    chainRootId?: string
    /** Set when this prompt originates from onExternalSend, not a human composer submit. */
    external?: boolean
  }) => void
  /** Reset a tab's chat thread: clears turns and run state (paired with sessions.newSession). */
  resetThread: (tabId: string) => void
  /**
   * Push an ephemeral, in-session-only notice turn (e.g. a slash-nav shortcut
   * acknowledgment). Does NOT touch running/stream/liveToolUses and is never
   * persisted via recordExchange — mirrors the IPC-driven applyNotice below.
   */
  pushNotice: (tabId: string, message: string) => void
  /** Set by voice.ts's onFinal for a dormant tab's recognized transcript. */
  setPendingVoiceText: (tabId: string, text: string) => void
  /** Consumed by TerminalChat's composer or voice.ts's armSubmit. */
  clearPendingVoiceText: (tabId: string) => void
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
  send: ({ tabId, sessionId, cwd, prompt, tag, chainRootId, external }) => {
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
        chainRootId,
        external,
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
    dispatchSend({ tabId, sessionId, cwd, text: trimmed, tag, chainRootId })
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
  setPendingVoiceText: (tabId, text) => {
    patch(tabId, (c) => ({ ...c, pendingVoiceText: text }))
  },
  clearPendingVoiceText: (tabId) => {
    patch(tabId, (c) => ({ ...c, pendingVoiceText: undefined }))
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
function dispatchSend(args: {
  tabId: string
  sessionId: string
  cwd: string
  text: string
  promptId?: string
  tag?: TicketTag
  chainRootId?: string
}): void {
  const { tabId, sessionId, cwd, text, promptId, tag, chainRootId } = args
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
    chainRootId,
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

  // External-origin tickets (Web Remote, admin HTTP route, MCP tool, or the
  // scheduler's own completion notifications — see PromptTicket.external)
  // were never a human's feature request, so they must never reach the
  // classifier and therefore can never be misrouted to dispatchToPrd().
  // Always dispatch inline, exactly like a non-'develop' verdict would.
  if (next.external) {
    dispatchQueuedInline(tabId, next)
    return
  }

  // A 'discussion' ticket is the user declaring intent up front: the goal is
  // an interactive research conversation with the agent, not work to be
  // decomposed. Classifying it anyway would let a well-argued research
  // question read as 'develop' and silently become a queued PRD — the exact
  // outcome the tag exists to rule out. Skip the classifier entirely (and its
  // claude -p cost) and stay inline, permanently.
  if (isDiscussionTag(next.tag)) {
    dispatchQueuedInline(tabId, next)
    return
  }

  classifyPromptTicket(next.text).then((verdict) => {
    if (verdict === 'develop') {
      dispatchToPrd(tabId, next)
      return
    }
    dispatchQueuedInline(tabId, next)
  })
}

/** Shared by dequeueNext()'s external-skip branch and its non-'develop'
 *  classifier verdict — installs the ticket as 'running' and hands it to
 *  chatRunner via the same dispatchSend() path a fresh manual send() uses. */
function dispatchQueuedInline(tabId: string, ticket: PromptTicket): void {
  const running: PromptTicket = { ...ticket, status: 'running', startedAt: Date.now() }
  patch(tabId, (c) => ({ ...c, activeTicket: running }))
  dispatchSend({
    tabId: running.tabId,
    sessionId: running.sessionId,
    cwd: running.cwd,
    text: running.text,
    promptId: running.id,
    tag: running.tag,
    chainRootId: running.chainRootId,
  })
}

/**
 * Authors a mechanical, templated draft PRD from a ticket's raw text (not a
 * real decomposition — the user reviews/edits the draft in the Scheduler
 * tab's PRD editor before it runs; see PRD implementation notes) and
 * transitions the ticket to 'dispatched-to-prd' with prdSlugs populated on
 * success, or 'failed' with a notice turn on failure.
 */
/**
 * Resolves the real, independently-sessioned PromptSession (promptSessions.ts)
 * this dispatch's PRD should be linked to. A "New item" ticket (no
 * chainRootId) mints a fresh PromptSession. A continuation ("Continue: <open
 * item>") reuses the ROOT ticket's already-minted PromptSession, looked up
 * from ticketHistory — never mints a second one for the same chain. Falls
 * back to minting one if the root's id can't be resolved (defensive; should
 * not happen for a chain reachable via the composer's chain picker).
 */
/**
 * Appends the 'prd_created' PromptSessionEvent for a just-authored PRD,
 * chained off the session's current tail event. Shared by dispatchToPrd
 * (legacy tab-ticket flow) and dispatchPromptSessionToPrd (direct Epic
 * conversation flow, PromptSessionConversation.tsx) so there is exactly one
 * place that knows how to fold a new PRD into a PromptSession's audit chain.
 * Best-effort: logs and returns on failure, never throws into the caller.
 */
function appendPrdCreatedEvent(promptSessionId: string, slug: string): void {
  try {
    const tail = usePromptSessions.getState().events[promptSessionId]?.slice(-1)[0]
    if (!tail) {
      window.api?.logs?.write(
        'chat',
        'warn',
        `appendPrdCreatedEvent: PromptSession ${promptSessionId} has no tail event — skipping prd_created append for ${slug}`,
      )
      return
    }
    usePromptSessions.getState().appendPromptSessionEvent(promptSessionId, {
      kind: 'prd_created',
      causedByEventId: tail.id,
      prdSlug: slug,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    window.api?.logs?.write('chat', 'warn', `appendPrdCreatedEvent failed for ${promptSessionId}: ${msg}`)
  }
}

/**
 * Dispatches a prompt straight from an Epic's own conversation
 * (PromptSessionConversation.tsx) as a new PRD — the direct-Epic counterpart
 * of dispatchToPrd, which only the legacy tab-ticket queue can reach. No
 * PromptTicket/tabId queue machinery involved: the PromptSession IS the unit
 * of work, so this only needs its id, cwd, the prompt text, and a tag.
 * Returns the created PRD's slug on success, or null on failure (having
 * already toasted the error).
 */
export async function dispatchPromptSessionToPrd(
  promptSessionId: string,
  cwd: string,
  text: string,
  tag: TicketTag,
): Promise<string | null> {
  try {
    const result = await window.api.chat.createPrd({
      title: deriveTitleFromTicketText(text),
      cwd,
      estimateMinutes: 15,
      goal: text,
      acceptanceCriteria: [
        'Implement the request described in Goal.',
        'timeout 300 npm run typecheck passes',
      ],
      implementationNotes: `Target project: ${cwd}`,
      sourcePromptId: promptSessionId,
      tag,
    })
    if (!result?.ok) {
      toast.error(`PRD authoring failed: ${result?.error ?? 'unknown error'}`)
      return null
    }
    const filename = result.filename
    const slug = filename.endsWith('.md') ? filename.slice(0, -3) : filename
    appendPrdCreatedEvent(promptSessionId, slug)
    return slug
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(`PRD authoring failed: ${msg}`)
    return null
  }
}

function resolveDispatchPromptSessionId(tabId: string, ticket: PromptTicket): string {
  if (ticket.chainRootId) {
    const cur = useChat.getState().chats[tabId] ?? EMPTY
    const root = (cur.ticketHistory ?? []).find((t) => t.id === ticket.chainRootId)
    if (root?.promptSessionId) return root.promptSessionId
    window.api?.logs?.write(
      'chat',
      'warn',
      `continuation ticket ${ticket.id}: no resolvable PromptSession for chainRootId ${ticket.chainRootId} — minting a new one`,
    )
  }
  return usePromptSessions.getState().createPromptSession(ticket.cwd, ticket.text).id
}

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

  const promptSessionId = resolveDispatchPromptSessionId(tabId, ticket)

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
      // The real PromptSession this dispatch is linked to — freshly minted
      // for a "New item" ticket, or the ROOT ticket's existing one for a
      // continuation (PRD 775/813).
      sourcePromptId: promptSessionId,
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
      // Isolated from the ticket-finalization path below: the PRD file is
      // already written and real by this point, so a throw here (a stale
      // tail, a missing session) must never fall through to the outer
      // .catch() and get this dispatch mislabeled 'failed' — that would
      // leave a real PRD orphaned with no prdSlugs and invite a duplicate
      // re-dispatch. appendPrdCreatedEvent is itself best-effort (never throws).
      appendPrdCreatedEvent(promptSessionId, slug)
      // A continuation does NOT carry prdSlugs on its own history entry — the
      // slug is appended to the ROOT ticket's prdSlugs below instead, so the
      // chip UI (which iterates a ticket's prdSlugs) shows the whole chain
      // under the single root entry rather than splitting it across tickets.
      const dispatched: PromptTicket = {
        ...ticket,
        status: 'dispatched-to-prd',
        completedAt: Date.now(),
        promptSessionId,
        ...(ticket.chainRootId ? {} : { prdSlugs: [slug] }),
      }
      applyNotice(tabId, dispatched.sessionId, `→ dispatched to PRD ${filename} (ticket ${dispatched.id})`)
      patch(tabId, (c) => {
        let history = appendTicketHistory(c.ticketHistory ?? [], dispatched)
        if (ticket.chainRootId) {
          const rootId = ticket.chainRootId
          history = history.map((t) =>
            t.id === rootId ? { ...t, prdSlugs: [...(t.prdSlugs ?? []), slug] } : t,
          )
        }
        return {
          ...c,
          running: false,
          queuedPosition: 0,
          activeTicket: null,
          ticketHistory: history,
        }
      })
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
    useChat.getState().send({ tabId, sessionId: tab.sessionId, cwd: tab.cwd, prompt, external: true })
  })
}
