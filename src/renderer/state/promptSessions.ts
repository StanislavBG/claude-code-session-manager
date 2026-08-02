import { create } from 'zustand'
import { useChat } from './chat'
import { useScheduleState } from './scheduleState'
import { useEpicTerminal } from './epicTerminal'
import { epicIdCandidates } from '../lib/epicProvenance'
import { splitTitleAndGoal } from '../lib/epicDerive'
import { toast } from './toast'
import type { TicketTag } from '../lib/ticketDisplay'

/**
 * A top-level goal-oriented prompt, promoted to its own independent Claude
 * session — distinct from the tab-scoped session model in sessions.ts/chat.ts
 * where every PromptTicket in a tab's queue shares the owning tab's
 * sessionId. A PromptSession mints its own claudeSessionId, never derived
 * from or shared with any SessionTab.
 */
/** Structured trace of which automated producer minted an Epic — replaces
 *  burying that info as markdown frontmatter text inside openingPrompt.
 *  Written by src/main/lib/epicMint.cjs for auto-minted Epics; absent for
 *  human-created ones (New Epic UI, /propose-epic approvals go through the
 *  same mint path but a human still pressed the button). */
export interface EpicSource {
  producer: 'rca-hook' | 'feedback-sweep' | 'propose-epic' | 'scheduler-dispatch'
  prdSlug?: string
  runId?: string
  sourceTabId?: string
}

export interface PromptSession {
  id: string
  cwd: string
  /** The original top-level prompt text that started this goal. */
  goalText: string
  /** Independently minted — NOT shared with any SessionTab.sessionId. */
  claudeSessionId: string
  /**
   * 'proposed' — filed by an agent/automation, NOT started. Its opening
   * prompt is held until a human approves it (approveProposed), which is what
   * replaced the old feedback-folder intake: a proposal is just an Epic that
   * hasn't been allowed to spend tokens yet.
   * 'active' — running/iterable. 'completed' — archived, claudeSessionId dead.
   */
  status: 'proposed' | 'active' | 'completed'
  createdAt: string
  completedAt: string | null
  /** Set only on a session minted via resumeArchived — traces back to the
   *  completed/archived PromptSession this one follows on from. The
   *  archived session's claudeSessionId is dead and never reused. */
  resumedFromId?: string | null
  /** Epic-level intent tag. Also written by src/main/lib/epicMint.cjs for
   *  Epics auto-minted from a headless PRD dispatch — stay shape-compatible
   *  so hydrate() reading a main-written active-index.json round-trips it. */
  tag?: TicketTag
  /** Full first-prompt body, when it differs from the display `goalText`
   *  (a proposal filed by automation: goalText is a one-line title, this is
   *  the RCA/analysis body). Sent verbatim on approval; falls back to
   *  goalText when absent. Written by src/main/lib/epicMint.cjs too. */
  openingPrompt?: string | null
  /** Which automated producer minted this Epic, for tracing a rogue/unexpected
   *  Epic back to its origin. Written by src/main/lib/epicMint.cjs; absent for
   *  human-created Epics. */
  source?: EpicSource
  /** Name of the Agent Library persona (`~/.claude/agents/<name>.md`) chosen to
   *  run this Epic's session, distinct from `tag` (the Epic's mission —
   *  feature/bug/discussion). Absent when the default agent was left selected.
   *  Display-only on the Epic; the persona's framing is folded into
   *  `openingPrompt` once, at creation, by composeEpicIntake (epicIntake.ts). */
  agent?: string
}

/** On-disk archive shape written by markCompleted and read back by any
 *  read-only history viewer — the single source of truth for both sides. */
export interface PromptSessionArchive {
  session: PromptSession
  events: PromptSessionEvent[]
  transcript: string
  archivedAt: string
  /** Full-text turns from the durable per-Epic transcript store
   *  (promptSessionTranscript.cjs), populated whenever `transcript` above
   *  came back empty — the raw `~/.claude/projects/...` JSONL copy is a
   *  one-shot best-effort snapshot that's empty if that file didn't exist
   *  yet or the session id didn't line up (PRD 863). Absent on older
   *  archives written before this field existed. */
  durableTurns?: Array<{ role: 'user' | 'assistant'; text: string; at: string }>
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

/**
 * Orders two events primarily by wall-clock `at`, falling back to the
 * causal `causedByEventId` chain when timestamps tie or fail to parse (equal
 * millisecond between an optimistic renderer append and a broadcasted
 * main-process append, or clock skew across machines). This is a tie-break
 * heuristic, not a full topological sort of the chain — out of scope per the
 * chain's own single-tail-FK model (see PromptSessionEvent's doc comment):
 * every event but the first has exactly one `causedByEventId`, so a direct
 * caused-by check is enough to fix the only two events that can actually
 * collide (a cause and its immediate effect); non-adjacent ties keep
 * wall-clock order.
 */
function compareEventsChainAware(a: PromptSessionEvent, b: PromptSessionEvent): number {
  const ta = Date.parse(a.at)
  const tb = Date.parse(b.at)
  const aValid = !Number.isNaN(ta)
  const bValid = !Number.isNaN(tb)
  if (aValid && bValid && ta !== tb) return ta - tb
  if (b.causedByEventId === a.id) return -1
  if (a.causedByEventId === b.id) return 1
  if (aValid && bValid) return 0
  if (aValid) return -1
  if (bValid) return 1
  return 0
}

interface PromptSessionsState {
  sessions: Record<string, PromptSession>
  events: Record<string, PromptSessionEvent[]>
  /** The Epic id currently open in the detail pane, kept in sync by
   *  EpicsWorkspace on every selection change (null when none is open).
   *  mergeAppendedEvent reads this to decide whether a landed 'response'
   *  event needs a toast — an Epic the user is already looking at doesn't,
   *  since its Discussion timeline already shows the event live. A single
   *  global slot assumes only one EpicsWorkspace instance is ever mounted
   *  at a time (true today — its two mount sites, TerminalStage's singleton
   *  and Terminal.tsx's per-dormant-tab mount, are mutually exclusive at
   *  runtime); if a future feature mounts two concurrently, this needs to
   *  become per-instance state instead of clobbering across them. */
  focusedEpicId: string | null
  setFocusedEpicId: (promptSessionId: string | null) => void
  /** Every Epic is born 'proposed' — this is the ONLY place a PromptSession
   *  is minted, and it can never write any other status. Nothing runs until
   *  approveProposed() flips it to 'active'. */
  createPromptSession: (
    cwd: string,
    goalText: string,
    tag?: PromptSession['tag'],
    source?: string,
    agent?: string,
  ) => PromptSession
  /** Flip a 'proposed' Epic to 'active' — the human approval gate. Returns the
   *  approved session, or null when the id is unknown or not a proposal.
   *  Starting its session is the caller's job (it owns the opening prompt). */
  approveProposed: (promptSessionId: string, source?: string) => PromptSession | null
  appendPromptSessionEvent: (
    promptSessionId: string,
    event: Omit<PromptSessionEvent, 'id' | 'promptSessionId' | 'at'>,
  ) => PromptSessionEvent
  /** User-triggered only (never auto-fired when a PRD lands). Kills the
   *  session's live chatRunner process, appends a 'closed' event, flips
   *  status to 'completed', and persists the full event chain + transcript
   *  to session-manager-operations/prompt-sessions/<id>.json. */
  markCompleted: (promptSessionId: string, source?: string) => Promise<void>
  /** Mints a brand-new independent PromptSession (fresh claudeSessionId —
   *  the archived one is dead) that carries a traceability link back to the
   *  archived session it follows on from. */
  resumeArchived: (archivedId: string, source?: string) => PromptSession
  /** Cosmetic correction only (typo/clarity in the queue row menu) — not a
   *  re-purposing of the Epic's goal. Re-encodes goalText as `${title}\n\n${goal}`,
   *  the same encoding EpicDetail.tsx's splitTitleAndGoal reads, and persists
   *  through the same active-index write path as every other mutation here.
   *  Throws if title.trim() is empty. */
  renameEpic: (promptSessionId: string, title: string, goal: string) => Promise<void>
  /** Mints a brand-new Epic from the source Epic's cwd/goalText/tag via the
   *  existing createPromptSession — fresh id + claudeSessionId, no PRDs/
   *  thread history/scheduler jobs carried over. Mirrors a hand-created Epic
   *  whose opening prompt happens to match an existing one. */
  duplicateEpic: (promptSessionId: string, source?: string) => PromptSession
  /** Removes the Epic from in-memory sessions/events and persists the removal
   *  through the active-index write path. Throws (never silently no-ops) if
   *  the Epic has a running/queued scheduler job or a chat run in flight —
   *  never deletes out from under live work. Does not touch on-disk PRD
   *  files or scheduler run logs. */
  deleteEpic: (promptSessionId: string, source?: string) => Promise<void>
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
  /** Merges a single event appended to a PromptSession's chain from the main
   *  process (scheduler's response-event append, via the
   *  promptSession:event-appended broadcast) into the in-memory event list —
   *  the live counterpart of hydrate()'s disk merge, for an Epic that's
   *  already loaded and doesn't need a full re-read. No-ops (silently) if the
   *  session isn't known yet, its cwd doesn't match, or the event id is
   *  already present (e.g. a `prd_created` this tab already appended
   *  optimistically via chat.ts's appendPrdCreatedEvent). */
  mergeAppendedEvent: (cwd: string, promptSessionId: string, event: PromptSessionEvent) => void
}

let seq = 0
function mintId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

type AuditEventKind =
  | 'epic_create'
  | 'epic_approve'
  | 'epic_complete'
  | 'epic_delete'
  | 'epic_resume'
  | 'epic_duplicate'

/** Fire-and-forget: an IPC failure logs a console warning and never blocks or
 *  rejects the store mutation it accompanies. `source` traces which renderer
 *  surface initiated the transition (NewEpicCard, EpicQueue Run Build, the
 *  approve bar, etc) — see auditLog.cjs's doc comment for why this exists. */
function emitAuditEvent(kind: AuditEventKind, fields: { cwd: string; epicId: string; source: string }): void {
  if (typeof window === 'undefined' || !window.api?.auditLog?.append) return
  window.api.auditLog.append(kind, fields).catch((err: unknown) => {
    console.warn(`[auditLog] failed to append ${kind}`, err)
  })
}

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
 *  every mutation so a reload never loses in-progress work. Sends only THIS
 *  renderer's own in-memory contribution to the main-process merge IPC
 *  (lib/activeIndexMerge.cjs's mergeActiveIndex, over
 *  window.api.promptSessions.mergeActiveIndex) rather than doing a
 *  read-merge-write itself. Moved main-side (was a renderer-side
 *  read-merge-write, commit 3d12e19) to close two holes that survived the
 *  first fix: (1) a resurrection hole — a second window still holding an
 *  archived/deleted Epic as open in memory could write that row right back
 *  on its next persist; the main-side merge now records a removal tombstone
 *  so a tombstoned id is dropped from every future merge's memory
 *  contribution, not just from the write that removed it; (2) a TOCTOU gap —
 *  the renderer's own read and write, round-tripped over separate IPC calls
 *  with no lock between them, could still lose an interleaved main-process
 *  mint (epicMint.cjs's ensureEpic). The main-side merge runs inside the same
 *  withPathLock instance ensureEpic already serializes through, closing that
 *  gap for real. `removedIds` is the ONLY way an id disappears from the
 *  written file (markCompleted/deleteEpic pass their own id there — the two
 *  entry points the domain model allows to erase a row). Best-effort: an IPC
 *  failure is logged, never thrown into the caller (createPromptSession and
 *  appendPromptSessionEvent are synchronous APIs their callers don't await).
 *  No-ops outside a renderer (tests that never stub window.api). */
function persistActiveIndex(
  cwd: string,
  sessions: Record<string, PromptSession>,
  events: Record<string, PromptSessionEvent[]>,
  removedIds: string[] = [],
): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.promptSessions?.mergeActiveIndex) return Promise.resolve()
  // Captured now, not re-read from the global inside the .then/.catch below —
  // those run on a later microtask, and in tests vi.unstubAllGlobals() in the
  // NEXT test's beforeEach can delete `window` out from under this closure
  // before this call settles, turning a benign failure log into an unhandled
  // ReferenceError.
  const api = window.api
  // Everything NOT YET ARCHIVED — 'proposed' as well as 'active'. A proposed
  // Epic is a valid minimal row (id + claudeSessionId are enough: reserved
  // and ready to spawn, with goalText/openingPrompt filling in later), not
  // junk to filter out. See prompt-sessions/README.md#lifecycle.
  const memorySessions = Object.fromEntries(
    Object.entries(sessions).filter(
      ([, s]) => s.cwd === cwd && (s.status === 'active' || s.status === 'proposed'),
    ),
  )
  const memoryEvents: Record<string, PromptSessionEvent[]> = {}
  for (const id of Object.keys(memorySessions)) {
    memoryEvents[id] = events[id] ?? []
  }
  const path = promptSessionActiveIndexPath(cwd)
  pendingWriteCounts.set(path, (pendingWriteCounts.get(path) ?? 0) + 1)
  const next = api.promptSessions
    .mergeActiveIndex({ cwd, sessions: memorySessions, events: memoryEvents, removedIds, source: 'epics' })
    .then(
      () => undefined,
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        api?.logs?.write('promptSessions', 'warn', `persistActiveIndex failed for ${cwd}: ${msg}`)
      },
    )
    .finally(() => {
      pendingWriteCounts.set(path, Math.max(0, (pendingWriteCounts.get(path) ?? 1) - 1))
    })
  return next
}

export const usePromptSessions = create<PromptSessionsState>((set, get) => ({
  sessions: {},
  events: {},
  focusedEpicId: null,
  setFocusedEpicId: (promptSessionId) => set({ focusedEpicId: promptSessionId }),
  createPromptSession: (cwd, goalText, tag, source, agent) => {
    const now = new Date().toISOString()
    const session: PromptSession = {
      id: mintId('psess'),
      cwd,
      goalText,
      claudeSessionId: crypto.randomUUID(),
      status: 'proposed',
      createdAt: now,
      completedAt: null,
      ...(tag ? { tag } : {}),
      ...(agent ? { agent } : {}),
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
    emitAuditEvent('epic_create', { cwd, epicId: session.id, source: source ?? 'unknown' })
    return session
  },
  approveProposed: (promptSessionId, source) => {
    const session = get().sessions[promptSessionId]
    if (!session || session.status !== 'proposed') return null
    const approved: PromptSession = { ...session, status: 'active' }
    const sessions = { ...get().sessions, [promptSessionId]: approved }
    set({ sessions })
    persistActiveIndex(session.cwd, sessions, get().events)
    emitAuditEvent('epic_approve', { cwd: session.cwd, epicId: promptSessionId, source: source ?? 'unknown' })
    return approved
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
  markCompleted: async (promptSessionId, source) => {
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
    // active index (which keeps everything not yet archived, i.e. 'active' and
    // 'proposed'). The explicit removedIds also strips it from disk even if
    // another writer's row for this id is still sitting there stale.
    persistActiveIndex(session.cwd, sessions, get().events, [promptSessionId])
    emitAuditEvent('epic_complete', { cwd: session.cwd, epicId: promptSessionId, source: source ?? 'unknown' })

    let transcript = ''
    try {
      const transcriptPath = await window.api.transcripts.pathFor(session.cwd, session.claudeSessionId)
      const result = await window.api.config.readText(transcriptPath)
      transcript = result.exists ? result.text : ''
    } catch {
      transcript = ''
    }

    // The raw ~/.claude/projects/... copy above is a one-shot best-effort
    // snapshot — empty whenever that file doesn't exist yet or the session
    // id doesn't line up. Fall back to the durable per-Epic transcript store
    // (promptSessionTranscript.cjs) so a completed Epic's archive always
    // carries its conversation. Both fields are kept when present rather
    // than one replacing the other.
    let durableTurns: PromptSessionArchive['durableTurns'] = undefined
    if (!transcript) {
      try {
        const { turns } = await window.api.promptSessionTranscript.read(session.cwd, promptSessionId)
        if (turns.length > 0) {
          durableTurns = turns.map((t) => ({ role: t.role, text: t.text, at: t.at }))
        }
      } catch {
        durableTurns = undefined
      }
    }

    const archive: PromptSessionArchive = {
      session: completed,
      events: get().events[promptSessionId] ?? [],
      transcript,
      archivedAt: now,
      ...(durableTurns ? { durableTurns } : {}),
    }
    await window.api.config.writeJson(promptSessionArchivePath(session.cwd, promptSessionId), archive, 'epics')
  },
  resumeArchived: (archivedId, source) => {
    const archived = get().sessions[archivedId]
    if (!archived) {
      throw new Error(`resumeArchived: no PromptSession with id "${archivedId}"`)
    }
    // Born 'proposed' like every Epic, then immediately approved — this is a
    // direct user button click (explicit intent), so activation is correct,
    // but it must still go through the one proposed->active transition.
    const resolvedSource = source ?? 'unknown'
    const proposed = get().createPromptSession(archived.cwd, archived.goalText, undefined, resolvedSource)
    const linked: PromptSession = { ...proposed, resumedFromId: archivedId }
    const sessions = { ...get().sessions, [proposed.id]: linked }
    set({ sessions })
    persistActiveIndex(linked.cwd, sessions, get().events)
    const approved = get().approveProposed(linked.id, resolvedSource)
    emitAuditEvent('epic_resume', { cwd: linked.cwd, epicId: linked.id, source: resolvedSource })
    return approved ?? linked
  },
  renameEpic: async (promptSessionId, title, goal) => {
    const session = get().sessions[promptSessionId]
    if (!session) {
      throw new Error(`renameEpic: no PromptSession with id "${promptSessionId}"`)
    }
    // Title occupies everything before the FIRST "\n\n" once persisted
    // (splitTitleAndGoal's decode side) — a newline-bearing title would
    // silently truncate itself and bleed into the goal on read-back, so
    // collapse it to one line before re-encoding.
    const trimmedTitle = title.trim().replace(/\s*\n+\s*/g, ' ')
    if (!trimmedTitle) {
      throw new Error('renameEpic: title must not be empty')
    }
    const goalText = `${trimmedTitle}\n\n${goal}`
    const renamed: PromptSession = { ...session, goalText }
    const sessions = { ...get().sessions, [promptSessionId]: renamed }
    set({ sessions })
    await persistActiveIndex(session.cwd, sessions, get().events)
  },
  duplicateEpic: (promptSessionId, source) => {
    const sourceSession = get().sessions[promptSessionId]
    if (!sourceSession) {
      throw new Error(`duplicateEpic: no PromptSession with id "${promptSessionId}"`)
    }
    // Born 'proposed' like every Epic, then immediately approved — this is a
    // direct user button click (explicit intent), so activation is correct,
    // but it must still go through the one proposed->active transition.
    const resolvedSource = source ?? 'unknown'
    const proposed = get().createPromptSession(sourceSession.cwd, sourceSession.goalText, sourceSession.tag, resolvedSource)
    const approved = get().approveProposed(proposed.id, resolvedSource) ?? proposed
    emitAuditEvent('epic_duplicate', { cwd: sourceSession.cwd, epicId: approved.id, source: resolvedSource })
    return approved
  },
  deleteEpic: async (promptSessionId, source) => {
    const session = get().sessions[promptSessionId]
    if (!session) {
      throw new Error(`deleteEpic: no PromptSession with id "${promptSessionId}"`)
    }
    // Same epicId → sourcePromptId → sourceTabId preference epicProvenance.ts
    // uses everywhere else a job/PRD is linked back to its Epic — sourcePromptId
    // alone can be stale frontmatter, so a live job whose PRD only carries the
    // (authoritative) epicId must still block deletion.
    const hasLiveJob = (useScheduleState.getState().snapshot?.jobs ?? []).some(
      (job) =>
        (job.status === 'running' || job.status === 'pending') &&
        epicIdCandidates(job).includes(promptSessionId),
    )
    if (hasLiveJob) {
      throw new Error('deleteEpic: this Epic has a running or queued scheduler job — cancel it first')
    }
    const chat = useChat.getState().chats[promptSessionId]
    if (chat && (chat.running || chat.queuedPosition > 0)) {
      throw new Error('deleteEpic: this Epic has a chat run in flight — wait for it to finish first')
    }
    if (useEpicTerminal.getState().isAttached(promptSessionId)) {
      throw new Error('deleteEpic: this Epic has a live Terminal session attached — detach it first')
    }
    const sessions = { ...get().sessions }
    const events = { ...get().events }
    delete sessions[promptSessionId]
    delete events[promptSessionId]
    set({ sessions, events })
    await persistActiveIndex(session.cwd, sessions, events, [promptSessionId])
    emitAuditEvent('epic_delete', { cwd: session.cwd, epicId: promptSessionId, source: source ?? 'unknown' })
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
              // Must match persistActiveIndex's filter exactly: this file now
              // holds proposed rows too, so a proposed Epic missing from disk
              // is a real deletion to reconcile, not a row that was never
              // persisted in the first place.
              (existingSessions[id].status === 'active' || existingSessions[id].status === 'proposed') &&
              !diskSessions[id],
          )
      const sessions = { ...existingSessions }
      const events = { ...get().events }
      let changed = false
      for (const id of newIds) {
        sessions[id] = diskSessions[id]
        events[id] = diskEvents[id] ?? []
        changed = true
      }
      for (const id of goneIds) {
        delete sessions[id]
        delete events[id]
        changed = true
      }
      // Merge path for Epics ALREADY in memory (the case a bare newIds/goneIds
      // check used to early-return on, silently discarding any event a
      // scheduler job appended to disk while this Epic sat open — PRD 855).
      // Adds any disk event this store hasn't seen yet by id; never removes
      // or overwrites an existing in-memory event, so an optimistic append
      // (e.g. chat.ts's appendPrdCreatedEvent) that hasn't hit disk yet is
      // never clobbered.
      for (const id of Object.keys(diskEvents)) {
        if (!existingSessions[id] || newIds.includes(id)) continue
        const diskEvts = diskEvents[id] ?? []
        const existingEvts = events[id] ?? []
        const existingIds = new Set(existingEvts.map((e) => e.id))
        const missing = diskEvts.filter((e) => !existingIds.has(e.id))
        if (missing.length > 0) {
          events[id] = [...existingEvts, ...missing].sort(compareEventsChainAware)
          changed = true
        }
      }
      if (!changed) return
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
  mergeAppendedEvent: (cwd, promptSessionId, event) => {
    const session = get().sessions[promptSessionId]
    if (!session || session.cwd !== cwd) return
    const existing = get().events[promptSessionId] ?? []
    // Dedup guard doubles as the "genuinely new, not a reload" check below —
    // a re-hydrate/re-broadcast of an event this store already has never
    // reaches the toast call past this early return.
    if (existing.some((e) => e.id === event.id)) return
    const events = {
      ...get().events,
      [promptSessionId]: [...existing, event].sort(compareEventsChainAware),
    }
    set({ events })
    // A PRD-completion notification landing on an Epic the user isn't
    // currently looking at is otherwise only discoverable by scrolling into
    // that Epic's own Discussion timeline — surface it via toast instead.
    if (event.kind === 'response' && promptSessionId !== get().focusedEpicId) {
      const { title } = splitTitleAndGoal(session.goalText)
      // Matches the one template notifyOriginatingTab's appendResponseEvent
      // call currently sends (`PRD ${slug} finished: ${status}. Check
      // Scheduler for details.`, src/main/scheduler.cjs's notifyOriginatingTab)
      // — keep this in sync if that message copy changes. Falls back
      // gracefully to a generic summary for any other 'response' text (e.g.
      // a future producer) rather than showing a broken toast.
      const slugMatch = event.text ? /^PRD (\S+) finished/.exec(event.text) : null
      const summary = slugMatch ? `PRD ${slugMatch[1]} finished` : 'Epic updated'
      toast.info(`${summary} — ${title}`)
    }
  },
}))

// ─── one-time global IPC subscription ──────────────────────────────────────
// Wired at module load (mirrors chat.ts's own onQueued/onOutput/... block).
// Guarded so a non-renderer import (tests) doesn't throw on a missing
// window.api. A broadcast for a cwd/session this app instance never
// hydrated is a silent no-op inside mergeAppendedEvent itself.
if (typeof window !== 'undefined' && window.api?.promptSessions) {
  window.api.promptSessions.onEventAppended(({ cwd, promptSessionId, event }) => {
    usePromptSessions.getState().mergeAppendedEvent(cwd, promptSessionId, event)
  })
}
