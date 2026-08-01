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
  /** Epic-level intent tag. Also written by src/main/lib/epicMint.cjs for
   *  Epics auto-minted from a headless PRD dispatch — stay shape-compatible
   *  so hydrate() reading a main-written active-index.json round-trips it. */
  tag?: 'feature' | 'bug' | 'discussion'
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

/** Where a cwd's *active* (not-yet-completed) PromptSessions + their event
 *  chains are persisted — a single per-cwd index, written on every create/
 *  append so a reload never loses in-progress work (unlike the archive,
 *  which is written once at completion). Sibling of promptSessionArchivePath
 *  under the same prompt-sessions/ root, so both live in one place to grep. */
export function promptSessionActiveIndexPath(cwd: string): string {
  return `${cwd.replace(/\/+$/, '')}/session-manager-operations/prompt-sessions/active-index.json`
}

interface PromptSessionActiveIndex {
  sessions: Record<string, PromptSession>
  events: Record<string, PromptSessionEvent[]>
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
  createPromptSession: (cwd: string, goalText: string, tag?: PromptSession['tag']) => PromptSession
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
  /** Reads a cwd's active-session index back from disk and merges it into
   *  the store — best-effort, one-shot per cwd at call time (safe to call
   *  repeatedly as ProjectsLanding discovers known cwds). In-memory state
   *  always wins over disk on id collision. No-ops if the index doesn't
   *  exist yet or window.api is unavailable (tests, non-renderer contexts). */
  hydrate: (cwd: string) => Promise<void>
  /** Reads every completed Epic's archive file
   *  (session-manager-operations/prompt-sessions/*.json, excluding
   *  active-index.json) back from disk and merges them in as
   *  status: 'completed' sessions with their events — the completed-Epic
   *  counterpart of hydrate(). Same in-memory-wins-on-collision, best-effort,
   *  no-op-if-window.api-unavailable semantics. */
  hydrateArchived: (cwd: string) => Promise<void>
}

let seq = 0
function mintId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

// Two independent fire-and-forget writes to the SAME path (e.g.
// resumeArchived's createPromptSession call immediately followed by its own
// persistActiveIndex call) are each an unawaited tmp+rename IPC round-trip —
// without serialization, whichever rename lands on disk *last* wins, not
// whichever was *issued* last, which could silently drop the later write's
// data. Chaining every write for a given path behind the previous one's
// settlement (success or failure) preserves issue order without the callers
// (synchronous store actions) needing to await anything.
const pendingWritesByPath = new Map<string, Promise<void>>()

// How many persists are still in flight per path. hydrate() reconciles
// disk-deleted Epics OUT of the store, and a just-created Epic exists in
// memory a beat before its write lands — reconciling during that window would
// delete it. A non-zero count here means "disk is knowably behind memory for
// this path", so hydrate() adds but never removes until it drains.
const pendingWriteCounts = new Map<string, number>()

function hasPendingWrite(path: string): boolean {
  return (pendingWriteCounts.get(path) ?? 0) > 0
}

/** Fire-and-forget persist of a cwd's active-session slice — called after
 *  every mutation so a reload never loses in-progress work. Best-effort: a
 *  write failure is logged, never thrown into the caller (createPromptSession
 *  and appendPromptSessionEvent are synchronous APIs their callers don't
 *  await). No-ops outside a renderer (tests that never stub window.api). */
function persistActiveIndex(cwd: string, sessions: Record<string, PromptSession>, events: Record<string, PromptSessionEvent[]>): void {
  if (typeof window === 'undefined' || !window.api?.config?.writeJson) return
  const index: PromptSessionActiveIndex = {
    sessions: Object.fromEntries(
      Object.entries(sessions).filter(([, s]) => s.cwd === cwd && s.status === 'active'),
    ),
    events: {},
  }
  for (const id of Object.keys(index.sessions)) {
    index.events[id] = events[id] ?? []
  }
  const path = promptSessionActiveIndexPath(cwd)
  pendingWriteCounts.set(path, (pendingWriteCounts.get(path) ?? 0) + 1)
  const prior = pendingWritesByPath.get(path) ?? Promise.resolve()
  const next = prior
    .then(() => window.api!.config.writeJson(path, index))
    .then(
      () => undefined,
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        window.api?.logs?.write('promptSessions', 'warn', `persistActiveIndex failed for ${cwd}: ${msg}`)
      },
    )
    .finally(() => {
      pendingWriteCounts.set(path, Math.max(0, (pendingWriteCounts.get(path) ?? 1) - 1))
    })
  pendingWritesByPath.set(path, next)
}

export const usePromptSessions = create<PromptSessionsState>((set, get) => ({
  sessions: {},
  events: {},
  createPromptSession: (cwd, goalText, tag) => {
    const now = new Date().toISOString()
    const session: PromptSession = {
      id: mintId('psess'),
      cwd,
      goalText,
      claudeSessionId: crypto.randomUUID(),
      status: 'active',
      createdAt: now,
      completedAt: null,
      ...(tag ? { tag } : {}),
    }
    const firstEvent: PromptSessionEvent = {
      id: mintId('pevt'),
      promptSessionId: session.id,
      kind: 'prompt',
      causedByEventId: null,
      at: now,
      text: goalText,
    }
    const sessions = { ...get().sessions, [session.id]: session }
    const events = { ...get().events, [session.id]: [firstEvent] }
    set({ sessions, events })
    persistActiveIndex(cwd, sessions, events)
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
    const events = { ...get().events, [promptSessionId]: [...existing, fullEvent] }
    set({ events })
    const session = get().sessions[promptSessionId]
    persistActiveIndex(session.cwd, get().sessions, events)
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
    const sessions = { ...get().sessions, [promptSessionId]: completed }
    set({ sessions })
    // Status flipped to 'completed' — persisting now drops it out of the
    // active index (persistActiveIndex only keeps status === 'active').
    persistActiveIndex(session.cwd, sessions, get().events)

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
    const sessions = { ...get().sessions, [session.id]: linked }
    set({ sessions })
    persistActiveIndex(session.cwd, sessions, get().events)
    return linked
  },
  hydrate: async (cwd) => {
    if (typeof window === 'undefined' || !window.api?.config?.readJson) return
    try {
      const path = promptSessionActiveIndexPath(cwd)
      const result = await window.api.config.readJson(path)
      const disk = (result.exists && result.data ? result.data : {}) as Partial<PromptSessionActiveIndex>
      const diskSessions = disk.sessions ?? {}
      const diskEvents = disk.events ?? {}
      // In-memory state always wins over disk on id collision — disk is only
      // there to backfill sessions this app instance hasn't loaded yet. Only
      // touch the store (and thus only re-render subscribers) when there's a
      // genuinely new id — an unconditional set() here would hand back a
      // fresh object reference on every call even when nothing changed,
      // which is exactly the shape of an effect-driven re-render loop.
      const existingSessions = get().sessions
      const newIds = Object.keys(diskSessions).filter((id) => !existingSessions[id])
      // Removals are the other half of hydration: this index is the source of
      // truth for which Epics are still ACTIVE in this cwd, and it is edited
      // out-of-band (another window, a tool, a manual cleanup). Without this
      // the store only ever grew, so Epics deleted on disk stayed listed as
      // Open forever — and the next persist wrote all of them back, undoing
      // the deletion. Scoped to this cwd's active Epics: completed ones live
      // in per-Epic archives (hydrateArchived) and are never in this file.
      // Skipped entirely while our own writes are in flight, since disk is
      // legitimately behind memory then.
      const goneIds = hasPendingWrite(path)
        ? []
        : Object.keys(existingSessions).filter(
            (id) =>
              existingSessions[id].cwd === cwd &&
              existingSessions[id].status === 'active' &&
              !diskSessions[id],
          )
      if (newIds.length === 0 && goneIds.length === 0) return
      const sessions = { ...existingSessions }
      const events = { ...get().events }
      for (const id of newIds) {
        sessions[id] = diskSessions[id]
        events[id] = diskEvents[id] ?? []
      }
      for (const id of goneIds) {
        delete sessions[id]
        delete events[id]
      }
      set({ sessions, events })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.api?.logs?.write('promptSessions', 'warn', `hydrate failed for ${cwd}: ${msg}`)
    }
  },
  hydrateArchived: async (cwd) => {
    if (typeof window === 'undefined' || !window.api?.config?.listDir || !window.api?.config?.readJson) return
    try {
      const dir = `${cwd.replace(/\/+$/, '')}/session-manager-operations/prompt-sessions`
      const result = await window.api.config.listDir(dir, { filesOnly: true })
      if (!result.ok) return
      const existingSessions = get().sessions
      const sessions = { ...existingSessions }
      const events = { ...get().events }
      let changed = false
      for (const entry of result.entries) {
        if (!entry.name.endsWith('.json') || entry.name === 'active-index.json') continue
        const id = entry.name.slice(0, -'.json'.length)
        // In-memory state always wins over disk on id collision, same as hydrate().
        if (sessions[id]) continue
        const fileResult = await window.api.config.readJson(entry.path)
        if (!fileResult.exists || !fileResult.data) continue
        const archive = fileResult.data as Partial<PromptSessionArchive>
        if (!archive.session || archive.session.id !== id) continue
        sessions[id] = { ...archive.session, status: 'completed' }
        events[id] = archive.events ?? []
        changed = true
      }
      if (!changed) return
      set({ sessions, events })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      window.api?.logs?.write('promptSessions', 'warn', `hydrateArchived failed for ${cwd}: ${msg}`)
    }
  },
}))
