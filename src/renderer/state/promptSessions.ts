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
  /** Set only on a session minted via resumeArchived — traces back to the
   *  completed/archived PromptSession this one follows on from. The
   *  archived session's claudeSessionId is dead and never reused. */
  resumedFromId?: string | null
}

/** On-disk archive shape written by markCompleted and read back by any
 *  read-only history viewer — the single source of truth for both sides. */
export interface PromptSessionArchive {
  session: PromptSession
  events: PromptSessionEvent[]
  transcript: string
  archivedAt: string
}

/** Where a PromptSession's archive lives once completed — shared by the
 *  writer (markCompleted) and any reader (history view) so the path is
 *  defined exactly once. */
export function promptSessionArchivePath(cwd: string, promptSessionId: string): string {
  return `${cwd.replace(/\/+$/, '')}/session-manager-operations/prompt-sessions/${promptSessionId}.json`
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
  /** User-triggered only (never auto-fired when a PRD lands). Kills the
   *  session's live chatRunner process, appends a 'closed' event, flips
   *  status to 'completed', and persists the full event chain + transcript
   *  to session-manager-operations/prompt-sessions/<id>.json. */
  markCompleted: (promptSessionId: string) => Promise<void>
  /** Mints a brand-new independent PromptSession (fresh claudeSessionId —
   *  the archived one is dead) that carries a traceability link back to the
   *  archived session it follows on from. */
  resumeArchived: (archivedId: string) => PromptSession
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
  markCompleted: async (promptSessionId) => {
    const session = get().sessions[promptSessionId]
    if (!session) {
      throw new Error(`markCompleted: no PromptSession with id "${promptSessionId}"`)
    }
    if (session.status === 'completed') return

    // Real kill path: a PromptSession's live process is a chatRunner child
    // process keyed by promptSessionId (chat.ts's chatKey), not a pty.cjs
    // tab — claudeSessionId was never registered with PtyManager. Cancel it
    // for real, and also hit pty:kill on claudeSessionId as the AC's named
    // reuse path (a harmless no-op today, cheap insurance if that ever
    // changes) rather than inventing a second kill mechanism.
    await window.api.chat.cancel(promptSessionId)
    window.api.pty.kill(session.claudeSessionId)

    const tail = get().events[promptSessionId]?.slice(-1)[0] ?? null
    if (tail) {
      get().appendPromptSessionEvent(promptSessionId, {
        kind: 'closed',
        causedByEventId: tail.id,
      })
    }

    const now = new Date().toISOString()
    const completed: PromptSession = { ...session, status: 'completed', completedAt: now }
    set({ sessions: { ...get().sessions, [promptSessionId]: completed } })

    let transcript = ''
    try {
      const transcriptPath = await window.api.transcripts.pathFor(session.cwd, session.claudeSessionId)
      const result = await window.api.config.readText(transcriptPath)
      transcript = result.exists ? result.text : ''
    } catch {
      transcript = ''
    }

    const archive: PromptSessionArchive = {
      session: completed,
      events: get().events[promptSessionId] ?? [],
      transcript,
      archivedAt: now,
    }
    await window.api.config.writeJson(promptSessionArchivePath(session.cwd, promptSessionId), archive)
  },
  resumeArchived: (archivedId) => {
    const archived = get().sessions[archivedId]
    if (!archived) {
      throw new Error(`resumeArchived: no PromptSession with id "${archivedId}"`)
    }
    const session = get().createPromptSession(archived.cwd, archived.goalText)
    const linked: PromptSession = { ...session, resumedFromId: archivedId }
    set({ sessions: { ...get().sessions, [session.id]: linked } })
    return linked
  },
}))
