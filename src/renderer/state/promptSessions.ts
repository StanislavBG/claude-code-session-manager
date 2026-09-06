import { create } from 'zustand'
import { useChat } from './chat'
import { useScheduleState } from './scheduleState'
import { useEpicTerminal } from './epicTerminal'
import { epicIdCandidates } from '../lib/epicProvenance'
import { splitTitleAndGoal } from '../lib/epicDerive'
import { toast } from './toast'
import type { TicketTag } from '../lib/ticketDisplay'
import type { EpicIntakeSection } from '../lib/epicIntake'

/**
 * A top-level goal-oriented prompt, promoted to its own independent Claude
 * session — distinct from the tab-scoped session model in sessions.ts/chat.ts
 * where every PromptTicket in a tab's queue shares the owning tab's
 * sessionId. A PromptSession mints its own claudeSessionId, never derived
 * from or shared with any SessionTab.
 */
/** Structured trace of which surface minted an Epic — replaces burying that
 *  info as markdown frontmatter text inside openingPrompt. An Epic is only
 *  ever created by a human pressing New Epic ('new-epic-ui', epicMint.cjs's
 *  SINGLE-CREATOR LAW); 'scheduler-dispatch' appears only on join-only calls
 *  kept for audit symmetry. 'cross-project-feedback' is the one other minting
 *  producer: a session in ANOTHER project deposited this Epic here as a
 *  'proposed' feedback proposal (src/main/lib/crossProjectFeedback.cjs). It
 *  still runs nothing until a human here presses Approve & start. */
export interface EpicSource {
  producer: 'new-epic-ui' | 'scheduler-dispatch' | 'cross-project-feedback'
  prdSlug?: string
  runId?: string
  sourceTabId?: string
  /** 'cross-project-feedback' only — the sending project's cwd. */
  fromCwd?: string
  /** 'cross-project-feedback' only — the sending Epic's id, if it had one. */
  fromEpicId?: string
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
  /** Epic-level intent tag. Every Epic — human-created via New Epic or
   *  automated — is constructed by src/main/lib/epicMint.cjs's ensureEpic();
   *  the renderer never builds this field itself, only receives and stores
   *  the record ensureEpic returns (createPromptSession's
   *  window.api.promptSessions.create call). */
  tag?: TicketTag
  /** Full first-prompt body, when it differs from the display `goalText`
   *  (a proposal filed by automation: goalText is a one-line title, this is
   *  the RCA/analysis body). Sent verbatim on approval; falls back to
   *  goalText when absent. Constructed by src/main/lib/epicMint.cjs's
   *  ensureEpic() for every Epic, same as `tag` above. */
  openingPrompt?: string | null
  /** Which surface minted this Epic, for tracing it back to its origin.
   *  Constructed by src/main/lib/epicMint.cjs's ensureEpic() for every Epic;
   *  absent on older Epics predating this field. */
  source?: EpicSource
  /** Name of the Agent Library persona (`~/.claude/agents/<name>.md`) chosen to
   *  run this Epic's session, distinct from `tag` (the Epic's mission —
   *  feature/bug/discussion). Named `agentType` (not `agent`) to match the
   *  same concept's existing name elsewhere in this app: Claude Code's own
   *  SubagentStart/Stop hook payloads use `agent_type`, the Task tool's own
   *  parameter is `subagent_type` (tracked as `subagentType` in
   *  state/live.ts's ToolUseTrace), and a Team member's persona field in
   *  teams.cjs is `agentType` — this is the same "which persona" value, so it
   *  carries the same field name rather than inventing a new one. Absent
   *  when the default agent was left selected. Display-only on the Epic; the
   *  persona's framing is folded into `openingPrompt` once, at creation, by
   *  composeEpicIntake (epicIntake.ts). */
  agentType?: string
  /** Labeled slices of `openingPrompt`, in the same order composeEpicIntake
   *  (epicIntake.ts) concatenates them: actor, injection(s), input, mission,
   *  goal, reference(s). Lets the Epic's first turn render a structured AIM
   *  briefing card instead of regex-parsing the flat string back apart.
   *  Absent on Epics minted before this field existed, and on any Epic whose
   *  opening prompt carried no sections (e.g. EpicQueue's scripted 'build'
   *  Epic) — those fall back to rendering `openingPrompt`/`goalText` as a
   *  single block. */
  sections?: EpicIntakeSection[]
  /** This Epic's isolated `git worktree` checkout, when one was created for
   *  it (`sm-epic/<id>` branch, src/main/lib/gitWorktree.cjs's
   *  createEpicWorktree). Absent when the project isn't a git repo, worktree
   *  isolation is disabled, or (until the next PRD in this chain wires
   *  minting) simply not created yet — this field is a passthrough read/write
   *  only as of PRD 1032; nothing populates it yet. `baseCwd` is always the
   *  Epic's real owning-project cwd (this.cwd), never the worktree dir
   *  itself — see gitWorktree.cjs's "ops-root hazard" header comment for why
   *  that distinction must never blur. */
  worktree?: {
    dir: string
    branch: string
    baseCwd: string
    status: 'active' | 'needs_merge_resolution' | 'merged' | 'disabled'
    /** Set alongside `status: 'needs_merge_resolution'` — the reason
     *  gitWorktree.cjs's `integrateEpicBranch` returned for the real
     *  conflict (PRD 1034/lib/epicWorktreeMerge.cjs), so a conflict banner
     *  reopened later (not just right after the button click that produced
     *  it) still has real data to show, never a placeholder. Cleared
     *  (omitted) whenever status moves off `needs_merge_resolution`. */
    conflictReason?: string
    /** Base-tree WIP paths carried into this worktree at creation time
     *  (gitWorktree.cjs's createWorktree, PRD 1094) — threaded back into
     *  mergeToMain so integrateEpicBranch can skip a doomed merge attempt
     *  when the branch's only committed changes are exactly this carried
     *  WIP. Absent when the base tree was clean when this worktree was
     *  created. */
    carriedPaths?: string[]
  }
}

/** On-disk archive shape written by markCompleted and read back by any
 *  read-only history viewer — the single source of truth for both sides. */
export interface PromptSessionArchive {
  session: PromptSession
  events: PromptSessionEvent[]
  transcript: string
  archivedAt: string
  /** Status mirror fields (see src/main/lib/epicStatusMirror.cjs) — copies of
   *  `session.status`/`session.cwd` plus a write timestamp, kept at the TOP
   *  level so activeIndexRebuild.cjs can read every prompt-sessions/<id>.json
   *  file uniformly without reaching into the nested `session` shape, which
   *  differs for a live (proposed/active) Epic's sparse mirror. Absent on
   *  archives written before this field existed. */
  status?: PromptSession['status']
  cwd?: string
  indexedAt?: string
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
  /** Required for kind: 'prd_created' — the PRD's actual filename/slug.
   *  Also carried on kind: 'response' when the scheduler's check-in names
   *  the PRD it came from (notifyOriginatingTab/notifyNeedsReview) — same
   *  field, not a parallel one, since both cases mean "which PRD is this
   *  event about." Optional so events written before this existed still
   *  decode fine. */
  prdSlug?: string
  /** Free-form text payload (prompt text, response text, closing note). */
  text?: string
  /** Present on kind: 'response' events the scheduler appends for a PRD
   *  check-in — the job's terminal or needs-review status at the moment it
   *  wrote this event, so the Epic's own audit trail keeps the outcome even
   *  after the job is archived out of queue.json. Optional so pre-existing
   *  on-disk events (and 'response' events from other sources, e.g. chat's
   *  onComplete) stay valid with no outcome tone. */
  outcome?: 'completed' | 'failed' | 'needs_review'
  /** PRD 986 — a scheduler PRD check-in is a REQUEST TO VALIDATE, not an
   *  assertion of done. Events the scheduler appends for a check-in are born
   *  'unvalidated' (never 'verified'), regardless of the job's self-reported
   *  outcome; the authoring Epic's own validation pass moves it to
   *  'verified'/'refuted'. Absent on pre-existing events (and on non-check-in
   *  events), which render exactly as before — renderer surfacing of this
   *  state is the sibling PRD, deliberately not this one. */
  validation?: 'unvalidated' | 'validating' | 'verified' | 'refuted'
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
   *  approveProposed() flips it to 'active'. Mints through main's own
   *  ensureEpic() (window.api.promptSessions.create, PRD 954) rather than
   *  hand-constructing id/claudeSessionId/status/createdAt itself — main is
   *  now the only place either id is generated. */
  createPromptSession: (
    cwd: string,
    goalText: string,
    tag?: PromptSession['tag'],
    source?: string,
    agentType?: string,
    /** Full opening-prompt body + its labeled sections (epicIntake.ts's
     *  composeEpicIntake) — persisted on the minted Epic alongside goalText
     *  so its first turn can render the AIM briefing card. Omitted by
     *  callers that never composed a full opening prompt (resumeArchived,
     *  EpicQueue's scripted 'build' Epic). */
    openingPrompt?: string,
    sections?: EpicIntakeSection[],
  ) => Promise<PromptSession>
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
  /** Explicit "merge to main" action (PRD 1034) — folds this Epic's isolated
   *  git worktree branch back into its owning project's main tree via the
   *  same integrateEpicBranch checkpoint markCompleted uses. No-ops (returns
   *  `{ ok: true }`) when the Epic has no worktree. On a real conflict, the
   *  worktree's status is patched to 'needs_merge_resolution' and the branch
   *  + worktree dir are left intact (never deleted) so a Terminal opened
   *  against this Epic can still resolve it manually before this is called
   *  again. */
  mergeEpicToMain: (promptSessionId: string) => Promise<{ ok: boolean; reason?: string }>
  /** Mints a brand-new independent PromptSession (fresh claudeSessionId —
   *  the archived one is dead) that carries a traceability link back to the
   *  archived session it follows on from. */
  resumeArchived: (archivedId: string, source?: string) => Promise<PromptSession>
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
  duplicateEpic: (promptSessionId: string, source?: string) => Promise<PromptSession>
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

/** Shared merge-to-main attempt (PRD 1034) used by both the explicit
 *  `mergeEpicToMain` action and markCompleted's merge-before-archive
 *  checkpoint — the ONLY point where an Epic's per-Epic git isolation
 *  (PRD 1032/1033) resolves back into its owning project's main tree.
 *  No-ops when the Epic has no worktree, or its worktree is already
 *  `'merged'`/`'disabled'` — nothing to (re-)attempt there. A worktree
 *  flagged `'needs_merge_resolution'` only re-attempts when `allowRetry` is
 *  set: markCompleted's own automatic checkpoint passes nothing (so a
 *  conflicted worktree is never silently retried mid-archive), while the
 *  explicit `mergeEpicToMain` action (EpicDetail/EpicQueue's own "Merge to
 *  main"/"Retry merge" buttons — PRD 1035) passes `true`, since a human
 *  pressing that button IS the explicit retry this module's contract always
 *  described. Never throws: an IPC failure (main process down, etc.) leaves
 *  the worktree exactly as it was rather than guessing a status. */
async function attemptMergeToMainInternal(
  session: PromptSession,
  allowRetry = false,
): Promise<{ worktree: PromptSession['worktree']; reason?: string }> {
  const worktree = session.worktree
  if (!worktree) return { worktree }
  if (worktree.status !== 'active' && !(allowRetry && worktree.status === 'needs_merge_resolution')) {
    return { worktree }
  }
  if (typeof window === 'undefined' || !window.api?.promptSessions?.mergeToMain) return { worktree }
  try {
    const result = await window.api.promptSessions.mergeToMain({
      cwd: session.cwd,
      epicId: session.id,
      branch: worktree.branch,
      dir: worktree.dir,
      carriedPaths: worktree.carriedPaths,
    })
    return {
      worktree: {
        ...worktree,
        status: result.ok ? 'merged' : 'needs_merge_resolution',
        conflictReason: result.ok ? undefined : result.reason,
      },
      reason: result.ok ? undefined : result.reason,
    }
  } catch {
    return { worktree }
  }
}

// Ids hydrate() has assigned into the store FROM the active-index disk read
// (never ids created locally by a user action in this runtime, e.g.
// createPromptSession). hydrateArchived() consults this to tell "stale
// active-index row left behind by a partially-failed completion" (safe to
// override with the archive) apart from "genuinely local unsaved state that
// happens to share an id" (must never be overridden) — see its own comment.
const indexBackedIds = new Set<string>()

/** Persists a cwd's active-session slice — called after every mutation so a
 *  reload never loses in-progress work. Sends only THIS renderer's own
 *  in-memory contribution to the main-process merge IPC
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
 *  entry points the domain model allows to erase a row).
 *
 *  The returned promise REJECTS on IPC failure (a `logs.write('warn')` still
 *  records the trace first, for grepping) — it is no longer swallowed into a
 *  silent resolve. Callers whose mutation must be durable before the UI
 *  treats it as such (markCompleted/deleteEpic/approveProposed/renameEpic)
 *  await this and roll their optimistic state back on rejection. Callers that
 *  intentionally stay fire-and-forget (createPromptSession,
 *  appendPromptSessionEvent, resumeArchived's own index write) must append
 *  their own `.catch(() => {})` — the log line above is their only record of
 *  failure, same as before this change. No-ops outside a renderer (tests that
 *  never stub window.api). */
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
        throw err instanceof Error ? err : new Error(msg)
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
  createPromptSession: async (cwd, goalText, tag, source, agentType, openingPrompt, sections) => {
    const result = await window.api.promptSessions.create({ cwd, goalText, tag, agentType, openingPrompt, sections })
    // ensureEpic's response is the byte-identical record just written to
    // active-index.json (validated against promptSessionSchema.cjs main-side)
    // — safe to trust as PromptSession without re-checking shape here.
    const session = result.session as unknown as PromptSession
    const firstEvent: PromptSessionEvent = {
      id: mintId('pevt'),
      promptSessionId: session.id,
      kind: 'prompt',
      causedByEventId: null,
      at: session.createdAt,
      text: goalText,
    }
    const sessions = { ...get().sessions, [session.id]: session }
    const events = { ...get().events, [session.id]: [firstEvent] }
    set({ sessions, events })
    persistActiveIndex(cwd, sessions, events).catch(() => {})
    emitAuditEvent('epic_create', { cwd, epicId: session.id, source: source ?? 'unknown' })
    return session
  },
  approveProposed: (promptSessionId, source) => {
    const session = get().sessions[promptSessionId]
    if (!session || session.status !== 'proposed') return null
    const approved: PromptSession = { ...session, status: 'active' }
    const sessions = { ...get().sessions, [promptSessionId]: approved }
    set({ sessions })
    // Kept synchronous (not awaited/async) because every caller relies on
    // getting the approved session back immediately to start its chat send
    // in the same tick. The persist below still gets the honest-contract
    // treatment: on rejection, roll the flip back to 'proposed' (unless
    // something else already moved this Epic further, e.g. markCompleted)
    // and toast — the row never keeps showing 'active' once we know disk
    // doesn't have it.
    const { title } = splitTitleAndGoal(session.goalText)
    persistActiveIndex(session.cwd, sessions, get().events).catch((err: unknown) => {
      const current = get().sessions[promptSessionId]
      if (current && current.status === 'active') {
        set({ sessions: { ...get().sessions, [promptSessionId]: { ...current, status: 'proposed' } } })
      }
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Could not start "${title}" — ${msg}. Reopened for review.`)
    })
    emitAuditEvent('epic_approve', { cwd: session.cwd, epicId: promptSessionId, source: source ?? 'unknown' })
    // Fire-and-forget: creates this Epic's isolated git worktree (main-side
    // gitWorktree.cjs's createEpicWorktree, PRD 1033) so its Terminal/Chat
    // spawn can run isolated from every sibling Epic on this project. Never
    // awaited and never blocks the transition above — approveProposed must
    // stay synchronous (see its own comment). Resolves to null on any
    // failure (not a repo / dirty base tree / disabled / cap reached), which
    // simply leaves `worktree` unset and the Epic proceeds exactly as today.
    if (typeof window !== 'undefined' && window.api?.promptSessions?.createWorktree) {
      window.api.promptSessions
        .createWorktree({ cwd: session.cwd, epicId: promptSessionId })
        .then((worktree) => {
          if (!worktree) return
          // Only settle onto a session that's still 'active' under this same
          // id — a completed/deleted Epic (or one a concurrent call already
          // patched) must never have a worktree grafted back onto it.
          const current = get().sessions[promptSessionId]
          if (!current || current.status !== 'active') return
          const withWorktree = { ...current, worktree }
          set({ sessions: { ...get().sessions, [promptSessionId]: withWorktree } })
          persistActiveIndex(session.cwd, get().sessions, get().events).catch(() => {})
        })
        .catch(() => {})
    }
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
    persistActiveIndex(session.cwd, get().sessions, events).catch(() => {})
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

    // Merge-to-main checkpoint (PRD 1034) — the ONLY point where this Epic's
    // isolated git worktree (PRD 1032/1033) resolves back into its owning
    // project's main tree; conflicts are only ever surfaced here, never
    // mid-session. A conflict never blocks archival — completed below still
    // runs either way — but the conflict flag/branch/dir carry onto the
    // archived record via `completed.worktree` so it isn't silently lost.
    const { worktree: mergedWorktree } = await attemptMergeToMainInternal(session)

    const priorSession = session
    const priorEvents = get().events[promptSessionId] ?? []
    const { title } = splitTitleAndGoal(session.goalText)

    const tail = priorEvents.slice(-1)[0] ?? null
    if (tail) {
      get().appendPromptSessionEvent(promptSessionId, {
        kind: 'closed',
        causedByEventId: tail.id,
      })
    }
    // Captured AFTER the optimistic 'closed' append above, so a rollback can
    // restore exactly this (pre-completion) event list.
    const closedEventList = get().events[promptSessionId] ?? priorEvents
    const eventsWithClosed = { ...get().events, [promptSessionId]: closedEventList }

    const now = new Date().toISOString()
    const completed: PromptSession = { ...session, worktree: mergedWorktree, status: 'completed', completedAt: now }
    const sessions = { ...get().sessions, [promptSessionId]: completed }
    set({ sessions })

    // Undoes the optimistic status flip + 'closed' event append above,
    // restoring the row disk actually still has, and tells the user why —
    // the honest-contract requirement this PRD exists for.
    const rollbackToOpen = (reason: string) => {
      set({
        sessions: { ...get().sessions, [promptSessionId]: priorSession },
        events: { ...get().events, [promptSessionId]: priorEvents },
      })
      toast.error(`Could not mark "${title}" completed — ${reason}`)
    }

    // Status flipped to 'completed' — persisting now drops it out of the
    // active index (which keeps everything not yet archived, i.e. 'active' and
    // 'proposed'). The explicit removedIds also strips it from disk even if
    // another writer's row for this id is still sitting there stale. Awaited:
    // the completion isn't durable (and the UI shouldn't show it as such)
    // until this lands.
    try {
      await persistActiveIndex(session.cwd, sessions, eventsWithClosed, [promptSessionId])
    } catch (err) {
      rollbackToOpen(err instanceof Error ? err.message : String(err))
      throw err
    }
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
      events: get().events[promptSessionId] ?? closedEventList,
      transcript,
      archivedAt: now,
      status: completed.status,
      cwd: completed.cwd,
      indexedAt: now,
      ...(durableTurns ? { durableTurns } : {}),
    }
    try {
      await window.api.config.writeJson(promptSessionArchivePath(session.cwd, promptSessionId), archive, 'epics')
    } catch (err) {
      rollbackToOpen(err instanceof Error ? err.message : String(err))
      // The active-index write above already removed this Epic's row from
      // disk (removedIds) — the archive that was meant to replace it just
      // failed to land, so put the row back rather than leaving the Epic in
      // neither place. Best-effort: any further failure here is already
      // logged inside persistActiveIndex itself.
      persistActiveIndex(priorSession.cwd, get().sessions, get().events).catch(() => {})
      throw err
    }
  },
  mergeEpicToMain: async (promptSessionId) => {
    const session = get().sessions[promptSessionId]
    if (!session) {
      throw new Error(`mergeEpicToMain: no PromptSession with id "${promptSessionId}"`)
    }
    const { worktree, reason } = await attemptMergeToMainInternal(session, true)
    // Only settle onto a session that's still the same one we started
    // against — a concurrent markCompleted/deleteEpic/another merge call
    // must never have its outcome overwritten by a stale one landing late.
    const current = get().sessions[promptSessionId]
    if (current && current.worktree === session.worktree) {
      const patched = { ...current, worktree }
      set({ sessions: { ...get().sessions, [promptSessionId]: patched } })
      persistActiveIndex(session.cwd, get().sessions, get().events).catch(() => {})
    }
    return { ok: worktree?.status === 'merged', reason }
  },
  resumeArchived: async (archivedId, source) => {
    const archived = get().sessions[archivedId]
    if (!archived) {
      throw new Error(`resumeArchived: no PromptSession with id "${archivedId}"`)
    }
    // Born 'proposed' like every Epic, then immediately approved — this is a
    // direct user button click (explicit intent), so activation is correct,
    // but it must still go through the one proposed->active transition.
    const resolvedSource = source ?? 'unknown'
    const proposed = await get().createPromptSession(archived.cwd, archived.goalText, undefined, resolvedSource)
    const linked: PromptSession = { ...proposed, resumedFromId: archivedId }
    const sessions = { ...get().sessions, [proposed.id]: linked }
    set({ sessions })
    persistActiveIndex(linked.cwd, sessions, get().events).catch(() => {})
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
    try {
      await persistActiveIndex(session.cwd, sessions, get().events)
    } catch (err) {
      // Rolled back so a failed write never leaves the rename showing as
      // durable. Rethrown (not toasted here) — every current caller of
      // renameEpic already awaits it and toasts the rejection itself.
      set({ sessions: { ...get().sessions, [promptSessionId]: session } })
      throw err
    }
  },
  duplicateEpic: async (promptSessionId, source) => {
    const sourceSession = get().sessions[promptSessionId]
    if (!sourceSession) {
      throw new Error(`duplicateEpic: no PromptSession with id "${promptSessionId}"`)
    }
    // Born 'proposed' like every Epic, then immediately approved — this is a
    // direct user button click (explicit intent), so activation is correct,
    // but it must still go through the one proposed->active transition.
    const resolvedSource = source ?? 'unknown'
    const proposed = await get().createPromptSession(sourceSession.cwd, sourceSession.goalText, sourceSession.tag, resolvedSource)
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
    const priorSessions = get().sessions
    const priorEvents = get().events
    const sessions = { ...priorSessions }
    const events = { ...priorEvents }
    delete sessions[promptSessionId]
    delete events[promptSessionId]
    set({ sessions, events })
    try {
      await persistActiveIndex(session.cwd, sessions, events, [promptSessionId])
    } catch (err) {
      // Rolled back so a failed write never leaves the Epic showing as
      // deleted. Rethrown (not toasted here) — every current caller of
      // deleteEpic already catches the rejection and toasts it itself.
      set({ sessions: priorSessions, events: priorEvents })
      throw err
    }
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
        indexBackedIds.add(id)
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
      // Ids reconciled this pass: a stale row that hydrate() loaded from
      // active-index.json (indexBackedIds) but which an archive file on disk
      // proves was actually already completed — a partially-failed
      // markCompleted that wrote its archive but never got to strip the
      // active-index row (or crashed between the two). The archive is the
      // newer, authoritative write in that case, so it wins here instead of
      // leaving the Epic stuck showing "Open" forever.
      const staleReconciled: string[] = []
      for (const entry of result.entries) {
        if (!entry.name.endsWith('.json') || entry.name === 'active-index.json') continue
        const id = entry.name.slice(0, -'.json'.length)
        const inMemory = sessions[id]
        const isStaleActiveIndexRow = !!inMemory && inMemory.status !== 'completed' && indexBackedIds.has(id)
        // In-memory state always wins over disk on id collision, same as
        // hydrate() — UNLESS it's a stale active-index leftover (above),
        // never a freshly-created local row that merely shares an id.
        if (inMemory && !isStaleActiveIndexRow) continue
        const fileResult = await window.api.config.readJson(entry.path)
        if (!fileResult.exists || !fileResult.data) continue
        const archive = fileResult.data as Partial<PromptSessionArchive>
        if (!archive.session || archive.session.id !== id) continue
        sessions[id] = { ...archive.session, status: 'completed' }
        events[id] = archive.events ?? []
        changed = true
        if (isStaleActiveIndexRow) staleReconciled.push(id)
      }
      if (!changed) return
      set({ sessions, events })
      // Strip the stale row(s) from active-index.json and record a removal
      // tombstone through the SAME merge path markCompleted/deleteEpic use —
      // no direct fs write. Fire-and-forget like every other reconciliation
      // write in hydrate()/hydrateArchived(); the in-memory fix above is what
      // the user sees immediately, and `sessions[id].status` is already
      // 'completed' by the time this resolves (or a concurrent hydrateArchived
      // call runs), so a repeat pass sees isStaleActiveIndexRow=false and
      // never re-issues this write — one-shot without extra bookkeeping.
      if (staleReconciled.length > 0) {
        persistActiveIndex(cwd, sessions, events, staleReconciled).catch(() => {})
      }
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
