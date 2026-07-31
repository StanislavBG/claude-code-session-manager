import { create } from 'zustand'

/**
 * A top-level goal-oriented prompt, promoted to its own independent Claude
 * session — distinct from the tab-scoped session model in sessions.ts/chat.ts
 * where every PromptTicket in a tab's queue shares the owning tab's
 * sessionId. A PromptSession mints its own claudeSessionId, never derived
 * from or shared with any SessionTab.
 */
export interface PromptSession {
  id: string
  cwd: string
  /** The original top-level prompt text that started this goal. */
  goalText: string
  /** Independently minted — NOT shared with any SessionTab.sessionId. */
  claudeSessionId: string
  status: 'active' | 'completed'
  createdAt: string
  completedAt: string | null
}

/**
 * One step in a PromptSession's Prompt → PRD → Response → ... → Closed
 * chain. `causedByEventId` strongly links each event to the exact prior
 * event it followed from, so the full history can be reconstructed and
 * audited later — referential integrity is an explicit requirement, not a
 * nice-to-have.
 */
export interface PromptSessionEvent {
  id: string
  promptSessionId: string
  kind: 'prompt' | 'prd_created' | 'response' | 'closed'
  /** FK to the exact prior event this one followed from — must be the
   *  session's current tail event (chain, not a tree). Null only for the
   *  first 'prompt' event in a session. */
  causedByEventId: string | null
  at: string
  /** Required for kind: 'prd_created' — the PRD's actual filename/slug. */
  prdSlug?: string
  /** Free-form text payload (prompt text, response text, closing note). */
  text?: string
}

interface PromptSessionsState {
  sessions: Record<string, PromptSession>
  events: Record<string, PromptSessionEvent[]>
  createPromptSession: (cwd: string, goalText: string) => PromptSession
  appendPromptSessionEvent: (
    promptSessionId: string,
    event: Omit<PromptSessionEvent, 'id' | 'promptSessionId' | 'at'>,
  ) => PromptSessionEvent
}

let seq = 0
function mintId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

export const usePromptSessions = create<PromptSessionsState>((set, get) => ({
  sessions: {},
  events: {},
  createPromptSession: (cwd, goalText) => {
    const now = new Date().toISOString()
    const session: PromptSession = {
      id: mintId('psess'),
      cwd,
      goalText,
      claudeSessionId: crypto.randomUUID(),
      status: 'active',
      createdAt: now,
      completedAt: null,
    }
    const firstEvent: PromptSessionEvent = {
      id: mintId('pevt'),
      promptSessionId: session.id,
      kind: 'prompt',
      causedByEventId: null,
      at: now,
      text: goalText,
    }
    set({
      sessions: { ...get().sessions, [session.id]: session },
      events: { ...get().events, [session.id]: [firstEvent] },
    })
    return session
  },
  appendPromptSessionEvent: (promptSessionId, event) => {
    if (!get().sessions[promptSessionId]) {
      throw new Error(`appendPromptSessionEvent: no PromptSession with id "${promptSessionId}"`)
    }
    const existing = get().events[promptSessionId] ?? []
    const tail = existing[existing.length - 1] ?? null
    if (event.causedByEventId !== null) {
      // A chain, not a tree: the referenced event must be the session's
      // current tail — the exact prior event, not merely some earlier one.
      if (!tail || event.causedByEventId !== tail.id) {
        throw new Error(
          `appendPromptSessionEvent: causedByEventId "${event.causedByEventId}" does not reference the current tail event of promptSession "${promptSessionId}"`,
        )
      }
    } else if (existing.length > 0) {
      throw new Error(
        `appendPromptSessionEvent: causedByEventId may only be null for a session's first event (promptSession "${promptSessionId}" already has ${existing.length})`,
      )
    }
    if (event.kind === 'prd_created' && !event.prdSlug) {
      throw new Error("appendPromptSessionEvent: kind 'prd_created' requires prdSlug")
    }
    const fullEvent: PromptSessionEvent = {
      ...event,
      id: mintId('pevt'),
      promptSessionId,
      at: new Date().toISOString(),
    }
    set({
      events: { ...get().events, [promptSessionId]: [...existing, fullEvent] },
    })
    return fullEvent
  },
}))
