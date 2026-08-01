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

**Required states**, in order:

| Status | Meaning | Entered by | Spends tokens |
| --- | --- | --- | --- |
| `draft` | The human is typing it. Not started, not visible to automation. | User opens New Epic and begins entering title/objective | No |
| `proposed` | An agent/automation is asking for this work. Awaits a human. | `ensureEpic(..., { status: 'proposed' })`, `/propose-epic`, `lib/rcaFeedbackHook.cjs` | No |
| `active` | The Epic's claude session is running. It authors PRDs and receives scheduler updates. | Human presses **Approve & start** (from `proposed`), or finishes the draft (from `draft`) | Yes |
| `completed` | Archived. `claudeSessionId` is dead and never reused. | `markCompleted()`, or **Discard** on a proposal | No |

An Epic starts at `proposed` **unless the human typed it**, in which case it starts at `draft`
and stays there while they type.

### The one way an Epic starts

`draft` and `proposed` are two doors into the same room. Both converge on a single start action —
send the Epic's `openingPrompt` (falling back to `goalText`) as the first message of its own
`claudeSessionId`:

- from `proposed`: the human presses **Approve & start** (`EpicApprovalBar`)
- from `draft`: the human finishes/submits the draft (`NewEpicCard`)

There must be exactly one code path that performs this, so an Epic can never begin two different
ways. Today both call `useChat.send({ tabId: epic.id, sessionId: epic.claudeSessionId, cwd, prompt: openingPrompt || goalText })`,
which is the behavior to preserve.

Once `active`, the Epic's session is what authors PRDs (via `scheduler_create_prd` / `chat:create-prd`,
carrying `sourcePromptId` = this Epic's id) and what the scheduler reports back into as
`prd_created` / `response` events on the Epic's chain. The Epic is the context root: PRDs are
never authored outside an `active` Epic.

### Known gaps (as of 2026-08-01)

1. **`draft` does not exist as an Epic status.** `PromptSession.status` is
   `'proposed' | 'active' | 'completed'`. `NewEpicCard` holds title/goal/tag in ephemeral React
   `useState` and calls `createPromptSession(cwd, goalText, tag)` with the default status
   `'active'` — so a human-typed Epic jumps straight to `active` and an in-progress draft is lost
   on navigate or reload. Implementing `draft` means persisting the form as a real Epic row.
2. **The name `draft` is already taken.** `EpicDisplayStatus` (`src/renderer/lib/epicDerive.ts`)
   uses `'draft'` for a *PRD* with no scheduler job row yet, and `epic-primitives.tsx` renders a
   badge for it. That is a different object at a different level. Adding an Epic-level `draft`
   requires disambiguating the two, or the Epics list will show one word meaning two things.
3. **Proposals are erased from disk by the next renderer write.** `epicMint.cjs` (main process)
   writes `proposed` Epics into `active-index.json`, but `persistActiveIndex` (renderer) rewrites
   that same file filtered to `status === 'active'` only. Any renderer mutation therefore drops
   every `proposed` Epic on disk; they survive in the renderer store until reload, then are gone.
   This silently destroys the agent-proposal intake that replaced the feedback folder. The filter
   must keep `proposed` as well as `active` (both are "not yet archived"), which also resolves the
   contradiction between this file's storage-layout note and the `active-index.json` shape note
   above.

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
