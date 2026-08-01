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

Only Epics with `status: 'active'` are persisted here (`persistActiveIndex` in
`promptSessions.ts` filters on `s.cwd === cwd && s.status === 'active'`) — a `'proposed'` Epic
that hasn't been approved yet, or a `'completed'` one, is not in this file (proposed Epics live
only in the renderer's in-memory store until approved; completed ones move to their own archive
below).

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

1. **Proposed** — an agent/automation files an Epic via `ensureEpic(..., { status: 'proposed' })`
   or `/propose-epic`. It exists in the renderer store but is NOT persisted to
   `active-index.json` and spends no tokens until a human presses **Approve & start**.
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
