import { create } from 'zustand'
import { toast } from './toast'

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

export type ChatTurnRole = 'user' | 'assistant' | 'question' | 'error'

export interface ChatTurn {
  id: string
  role: ChatTurnRole
  /** Rendered text. For a question turn, the joined prompt; questions[] holds the items. */
  text: string
  questions?: string[]
  at: number
}

interface TabChat {
  turns: ChatTurn[]
  /** A run is in flight — input is disabled. */
  running: boolean
  /** The session has been created at least once → subsequent sends resume it. */
  started: boolean
  /** Live streamed assistant text for the in-flight run (replaced by finalMessage on complete). */
  stream: string
}

interface ChatState {
  chats: Record<string, TabChat>
  /** Read (or lazily create) the chat slice for a tab. */
  get: (tabId: string) => TabChat
  /** Submit a user command for a tab. sessionId is the tab's claudeSessionId. */
  send: (args: { tabId: string; sessionId: string; cwd: string; prompt: string }) => void
}

const EMPTY: TabChat = { turns: [], running: false, started: false, stream: '' }

let seq = 0
function turnId(): string {
  seq += 1
  return `t${Date.now().toString(36)}-${seq}`
}

export const useChat = create<ChatState>((set, get) => ({
  chats: {},
  get: (tabId) => get().chats[tabId] ?? EMPTY,
  send: ({ tabId, sessionId, cwd, prompt }) => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const cur = get().chats[tabId] ?? EMPTY
    if (cur.running) return
    const userTurn: ChatTurn = { id: turnId(), role: 'user', text: trimmed, at: Date.now() }
    set({
      chats: {
        ...get().chats,
        [tabId]: { ...cur, turns: [...cur.turns, userTurn], running: true, stream: '' },
      },
    })
    // resume on every send after the first (the session was created on the first run).
    window.api.chat
      .run({ tabId, sessionId, prompt: trimmed, cwd, resume: cur.started })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        applyError(tabId, sessionId, msg)
      })
  },
}))

// ─── internal mutators driven by IPC events ────────────────────────────────

function patch(tabId: string, fn: (c: TabChat) => TabChat): void {
  const cur = useChat.getState().chats[tabId] ?? EMPTY
  useChat.setState({ chats: { ...useChat.getState().chats, [tabId]: fn(cur) } })
}

function pushTurn(tabId: string, turn: ChatTurn, extra: Partial<TabChat> = {}): void {
  patch(tabId, (c) => ({ ...c, turns: [...c.turns, turn], running: false, stream: '', ...extra }))
}

function applyError(tabId: string, _sessionId: string, message: string): void {
  pushTurn(tabId, { id: turnId(), role: 'error', text: message, at: Date.now() })
  toast.error(message)
}

// ─── one-time global IPC subscription ──────────────────────────────────────
// Wired at module load (like live.ts subscribes to transcript events). Guarded
// so a non-renderer import (tests) doesn't throw on a missing window.api.

if (typeof window !== 'undefined' && window.api?.chat) {
  window.api.chat.onRunStarted(({ tabId }) => {
    patch(tabId, (c) => ({ ...c, running: true, started: true, stream: '' }))
  })
  window.api.chat.onOutput(({ tabId, delta }) => {
    patch(tabId, (c) => ({ ...c, stream: c.stream + delta }))
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
}
