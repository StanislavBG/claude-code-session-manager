import { create } from 'zustand'
import { toast } from './toast'
import { transcriptExists } from '../lib/transcriptExists'

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
}

interface ChatState {
  chats: Record<string, TabChat>
  /** Tabs for which history hydration has been attempted (exactly once per tab). */
  hydratedTabs: Record<string, true>
  /** Read (or lazily create) the chat slice for a tab. */
  get: (tabId: string) => TabChat
  /** Submit a user command for a tab. sessionId is the tab's chatSessionId. */
  send: (args: { tabId: string; sessionId: string; cwd: string; prompt: string }) => void
  /** Reset a tab's chat thread: clears turns and run state (paired with sessions.newChatThread). */
  resetThread: (tabId: string) => void
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
}

let seq = 0
function turnId(): string {
  seq += 1
  return `t${Date.now().toString(36)}-${seq}`
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
  send: ({ tabId, sessionId, cwd, prompt }) => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const cur = get().chats[tabId] ?? EMPTY
    if (cur.running) return
    const userTurn: ChatTurn = { id: turnId(), role: 'user', text: trimmed, at: Date.now() }
    set({
      chats: {
        ...get().chats,
        [tabId]: { ...cur, turns: [...cur.turns, userTurn], running: true, queuedPosition: 0, stream: '' },
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
      .then((resume) =>
        window.api.chat.run({ tabId, sessionId, prompt: trimmed, cwd, resume }),
      )
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        applyError(tabId, sessionId, msg)
      })
  },
  resetThread: (tabId) => {
    set({
      chats: {
        ...get().chats,
        [tabId]: { ...EMPTY },
      },
    })
  },
}))

// ─── internal mutators driven by IPC events ────────────────────────────────

function patch(tabId: string, fn: (c: TabChat) => TabChat): void {
  const cur = useChat.getState().chats[tabId] ?? EMPTY
  useChat.setState({ chats: { ...useChat.getState().chats, [tabId]: fn(cur) } })
}

function pushTurn(tabId: string, turn: ChatTurn, extra: Partial<TabChat> = {}): void {
  patch(tabId, (c) => ({
    ...c,
    turns: [...c.turns, { ...turn, toolUses: c.liveToolUses }],
    running: false,
    queuedPosition: 0,
    stream: '',
    liveToolUses: [],
    ...extra,
  }))
}

function applyError(tabId: string, _sessionId: string, message: string): void {
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
  window.api.chat.onNeedsInput(({ tabId, questions }) => {
    pushTurn(tabId, {
      id: turnId(),
      role: 'question',
      text: questions.join('\n'),
      questions,
      at: Date.now(),
    })
  })
  window.api.chat.onError(({ tabId, sessionId, message }) => {
    applyError(tabId, sessionId, message)
  })
  window.api.chat.onNotice(({ tabId, sessionId, message }) => {
    applyNotice(tabId, sessionId, message)
  })
}
