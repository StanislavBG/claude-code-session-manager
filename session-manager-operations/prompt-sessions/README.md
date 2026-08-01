# Prompt sessions (Epics) — session-manager

This folder is the durable store for **Epics** — the app's term for a `PromptSession`: one
top-level unit of work, promoted to its own independent Claude session (`claudeSessionId`,
never shared with or derived from any Terminal tab's `sessionId`). Chat and Terminal are two
views over that one session; the Epics list is the user's list of tagged sessions they iterate
in. See `CLAUDE.md`'s "Domain model (TAB / EPIC)" section for the full hierarchy this folder sits
under.

## Storage layout

```
session-manager-operations/prompt-sessions/
  active-index.json          — every Epic in this cwd that is 'proposed' or 'active'
  <promptSessionId>.json      — one archive file per COMPLETED Epic (e.g. psess-ms9x7241-9.json)
  attachments/                 — pasted images referenced from an Epic's goalText/openingPrompt
  transcripts/                 — durable per-Epic transcript store (promptSessionTranscript.cjs)
```

Path helpers: `promptSessionActiveIndexPath(cwd)` and `promptSessionArchivePath(cwd, id)` in
`src/renderer/state/promptSessions.ts` are the single source of truth for both — don't
reconstruct these paths ad hoc.

## Required shape

### `active-index.json`

```ts
{
  sessions: Record<string, PromptSession>,
  events: Record<string, PromptSessionEvent[]>,
}
```

Intended contents: every **not-yet-archived** Epic for this cwd — i.e. `proposed` *and* `active`.
Completed Epics move to their own archive file (below) and drop out of here.

⚠️ The two writers currently disagree, which is Lifecycle **gap 3**: `lib/epicMint.cjs` (main)
writes `proposed` Epics into this file, while `persistActiveIndex` (renderer) rewrites it
filtered to `s.cwd === cwd && s.status === 'active'`, deleting them. Until that filter is
widened to keep `proposed`, a proposal on disk survives only until the next renderer mutation.

`PromptSession` (real fields, from `src/renderer/state/promptSessions.ts:10-40`):

```ts
interface PromptSession {
  id: string
  cwd: string
  goalText: string                       // the original top-level prompt; fixed for the Epic's life
  claudeSessionId: string                // independently minted, never shared with a SessionTab
  status: 'proposed' | 'active' | 'completed'
  createdAt: string
  completedAt: string | null
  resumedFromId?: string | null          // set only when minted via resumeArchived()
  tag?: 'feature' | 'bug' | 'discussion' // Epic-level intent tag
  openingPrompt?: string | null          // full first-prompt body, when it differs from goalText
}
```

`PromptSessionEvent` (`promptSessions.ts:86-99`) — one step in the Epic's
`prompt → prd_created → response → closed` chain, FK-linked via `causedByEventId` (must reference
the session's current *tail* event — a chain, not a tree; `null` only for the first event):

```ts
interface PromptSessionEvent {
  id: string
  promptSessionId: string
  kind: 'prompt' | 'prd_created' | 'response' | 'closed'
  causedByEventId: string | null
  at: string
  prdSlug?: string   // required when kind === 'prd_created'
  text?: string       // free-form payload (prompt text, response text, closing note)
}
```

### `<promptSessionId>.json` (archive)

Written once, at completion, by `markCompleted()`. `PromptSessionArchive`
(`promptSessions.ts:44-56`):

```ts
{
  session: PromptSession,        // status: 'completed', completedAt stamped
  events: PromptSessionEvent[],  // the full chain at the moment of archiving
  transcript: string,             // one-shot best-effort copy of the raw ~/.claude/projects/... JSONL
  archivedAt: string,
  durableTurns?: Array<{ role: 'user' | 'assistant'; text: string; at: string }>,
  // ^ populated from the transcripts/ store below, only when `transcript` came back empty
}
```

## Ownership

Sole writer per `src/main/lib/opsOwnership.cjs`'s `OWNERS` table: **`epics`**. Every write from
the renderer declares this writer id through the IPC payload (`config.writeJson(path, data,
'epics')`); `lib/epicMint.cjs` writes `active-index.json` directly via `fs` for the same reason.

**Declared delegation** (`opsOwnership.cjs`'s `DELEGATIONS` table): the **`scheduler`** writer may
write `active-index.json` — and only that one file, at its top level — because the scheduler
appends `prd_created`/`response` events to the Epic that spawned a job
(`promptSessionEvents.cjs`) and mints/joins an Epic when a PRD is created (`epicMint.cjs`), both
in the main process with no renderer attached to do it as `epics` instead. No other file in this
namespace, and no other writer, is permitted — a write from anything else throws
(`assertOpsWrite`).

## Lifecycle

> **This section is the functional requirement for the Epic object's lifecycle.** It is the one
> place the states and their transitions are defined — do not restate them in PRDs, skills or
> other docs; link here instead. Where the shipped code does not yet match, that is called out
> inline as a **GAP** rather than silently documented as if it worked.

### The single status field

An Epic has exactly **one** status field, `PromptSession.status`, and changing it IS the
lifecycle. Nothing else — no second flag, no derived "is it started" boolean, no separate
approval record — may encode where an Epic sits in its life. Any surface that needs to know the
Epic's stage reads this field.

**There are exactly three states.** No fourth.

| Status | Meaning | Entered by | Spends tokens |
| --- | --- | --- | --- |
| `proposed` | Not started. Either an agent is asking for the work, or a human is still typing it. | `ensureEpic(..., { status: 'proposed' })`, `/propose-epic`, `lib/rcaFeedbackHook.cjs`, **and** the New Epic form | No |
| `active` | The Epic's session is running. It authors PRDs and receives scheduler updates. | Human presses **Approve & start**, or finishes the draft — the same transition | Yes |
| `completed` | Archived. `claudeSessionId` is dead and never reused. | `markCompleted()`, or **Discard** on a proposal | No |

**There is no `draft` state.** A half-typed Epic is simply `proposed`: it has not started and has
spent nothing, which is exactly what `proposed` already means. "The human is still typing" and
"an agent is asking" need no distinction at the state level — both are *not started, awaiting a
human to commit*. Adding a fourth state to encode who authored it would put authorship in the
status field, where it does not belong.

### Every Epic is born `proposed`

`proposed` is the birth state for **every** Epic, whoever authored it. Nothing is ever created
directly as `active`. An Epic becomes `active` only by an explicit start transition — never as a
side effect of being created.

### The one way an Epic starts

There is one transition, `proposed → active`, reached by two equivalent human acts:

- **Approve & start** on an agent's proposal (`EpicApprovalBar`)
- **Submitting the first prompt** in the New Epic flow — giving it a title and starting prompt and
  hitting send IS the transition, not a separate kind of creation

Both must run one code path: send the Epic's `openingPrompt` (falling back to `goalText`) as the
first message of its own `claudeSessionId`. Today that is
`useChat.send({ tabId: epic.id, sessionId: epic.claudeSessionId, cwd, prompt: openingPrompt || goalText })`,
which is the behavior to preserve. An Epic can never begin two different ways.

### A `proposed` Epic is a minimal row, and is never erased

A `proposed` Epic needs only **`id` and `claudeSessionId`** (plus `cwd` and `status`) to be a
valid, durable row — an Epic reserved and ready to be spawned. `goalText`, `openingPrompt` and
`tag` may be empty and fill in later; they are not required for the row to exist or to persist.

This is what makes "no `draft` state" work without losing anything. The New Epic flow can mint the
minimal `proposed` row up front and fill fields in as they are typed: what is *not* persisted is a
separate draft **state**, not the Epic itself. There is still one birth state and one start path,
and a human Epic can be parked as a proposal indefinitely without being started.

Because such a row is legitimate, **nothing about a `proposed` Epic is ever erased** — a
persister that cannot see a use for a sparse row must still keep it. See gap 3.

Once `active`, the Epic's session is what authors PRDs (via `scheduler_create_prd` / `chat:create-prd`,
carrying `sourcePromptId` = this Epic's id) and what the scheduler reports back into as
`prd_created` / `response` events on the Epic's chain. The Epic is the context root: PRDs are
never authored outside an `active` Epic.

### Persisted state vs. derived display

**Only the actual state may be shown as the Epic's state.** `status` is the only persisted
lifecycle value; anything else the UI computes is a *view*, never a state, and must never be
written back onto the Epic. Equally, nothing persisted may be silently recomputed — if a badge
says `proposed`, that is because the field says `proposed`.

Activity signals (is a run in flight, is it queued behind the session-slot pool, is it waiting on
an answer) are real and worth showing — but they are **not Epic state**. They belong to the
entity that owns them, and are displayed as that entity's status, beside the Epic's own.

### The three entities

The workflow has three objects, each owning its own properties. Keeping the boundary clean is
what stops one badge from meaning three different things.

| Entity | Owns | Purpose |
| --- | --- | --- |
| **EPIC** (`PromptSession`) | `id`, `cwd`, `goalText`, `openingPrompt`, `tag`, `status`, `createdAt`, `completedAt`, `resumedFromId` | The unit of work and the human gate. Its properties **control the session**: what it is about, where it runs, and what first prompt starts it. |
| **SESSION** (the claude session, 1:1 with its Epic) | `claudeSessionId`, attachment/view (Chat vs Terminal — mutually exclusive), running / queued / needs-input, queue position, model + effort, token usage, transcript, event chain | The thing that actually executes. Its properties **write the PRDs**. |
| **PRD** | `slug`, `title`, `cwd`, `estimateMinutes`, `dependsOn`, `sourcePromptId`, `sourceTabId`, `parallelGroup`, `tag`, and its queue-row `status` (`pending` / `running` / `completed` / `failed` / `needs_review`) | One dispatched piece of work, authored by a session and executed by the scheduler. |

A property goes on the entity whose lifecycle it shares. If a new field is needed to track or
display run activity, it goes on the **session**, not the Epic — an Epic outlives any one run,
and an Epic that is `active` says nothing about whether a run is in flight right now.

### Known gaps (as of 2026-08-01)

1. **A human-typed Epic is born `active`, skipping both the birth state and the shared
   transition.** `NewEpicCard` calls `createPromptSession(cwd, goalText, tag)`, whose status
   argument defaults to `'active'`, and separately fires the opening prompt — so `active` gets set
   by the act of creation rather than by starting, and the New Epic path never touches the
   `proposed → active` transition that Approve uses. It should create the Epic `proposed` and then
   take that same transition, so there is one birth state and one start path.
2. **`epicDisplayStatus` invents state that isn't state.** `src/renderer/lib/epicDerive.ts`
   returns a six-value `EpicDisplayStatus` (`running`/`needs`/`queued`/`completed`/`proposed`/`draft`)
   from one function, mixing all three entities: `completed`/`proposed` are real Epic status,
   `running`/`queued`/`needs` are **session** activity, and the final fallback returns
   **`'draft'` for an `active` Epic that simply has nothing in flight** — a label for a state that
   does not exist, shown in place of the Epic's real one. (`epicPrds` separately uses `'draft'`
   for a PRD file with no job row yet, which is a **PRD** property and a legitimate derived view.)
   An idle `active` Epic must read `active`; session activity must be surfaced as the session's
   status, not substituted for the Epic's.
3. **Proposals are erased from disk by the next renderer write.** `epicMint.cjs` (main process)
   writes `proposed` Epics into `active-index.json`, but `persistActiveIndex` (renderer) rewrites
   that same file filtered to `status === 'active'` only. Any renderer mutation therefore drops
   every `proposed` Epic on disk; they survive in the renderer store until reload, then are gone.
   This silently destroys the agent-proposal intake that replaced the feedback folder, and it
   blocks the minimal-row model above: a reserved `proposed` Epic cannot survive to be spawned if
   the next write deletes it.

   Fix: `persistActiveIndex` must keep `proposed` as well as `active` — the file holds everything
   **not yet archived**, and a sparse `proposed` row (`id` + `claudeSessionId` only) is valid
   content, not junk to be filtered out. Nothing about a `proposed` Epic is ever erased; only
   `markCompleted` removes a row from this file, by moving it to its archive. This also resolves
   the contradiction between this file's storage-layout note and the `active-index.json` shape
   note above.

### Transitions in detail

1. **Proposed** — an agent/automation files an Epic via `ensureEpic(..., { status: 'proposed' })`
   or `/propose-epic`. Nothing runs and nothing is spent until a human presses **Approve & start**.
   A re-trigger for the same goal joins the pending proposal and may enrich its `openingPrompt` in
   place (`reuseByGoal`) rather than filing a duplicate — legal only while `proposed`, since an
   `active` Epic's first turn is already history. **Discard** archives the proposal
   (`markCompleted`) instead of deleting it, so a rejection stays auditable.
2. **Active** — `active-index.json` carries the Epic and its event chain. Every
   create/append mutation re-persists the full active slice for this cwd (fire-and-forget,
   serialized per-path so concurrent writes to the same file can't race each other out of order).
3. **Completed** — `markCompleted()` kills the Epic's live process, appends a `closed` event,
   flips `status` to `'completed'`, writes the full archive to `<id>.json`, and the Epic drops out
   of `active-index.json` (persist only keeps `status === 'active'` rows). The Epic's
   `claudeSessionId` is dead from this point — resuming it (`resumeArchived`) mints a brand-new
   `claudeSessionId` and records `resumedFromId` tracing back to the archived Epic.
4. **Hydration** — `hydrate(cwd)` reads `active-index.json` back on load (in-memory always wins on
   id collision; disk-deleted Epics are reconciled out, but only once no write to that path is
   still in flight). `hydrateArchived(cwd)` separately walks every `*.json` file in this folder
   (excluding `active-index.json`) to backfill completed Epics.
