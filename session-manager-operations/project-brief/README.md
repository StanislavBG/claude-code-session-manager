# Project Brief — session-manager

This folder stores the per-project **Brief** — an LLM-synthesized summary of the project
(purpose, what it is, how it's structured, how scope moved, its conventions) that Home surfaces as
a living document. Backend: `src/main/projectBrief.cjs` (+ core logic in
`src/main/lib/projectBriefCore.cjs`).

## Storage layout

```
session-manager-operations/project-brief/
  brief.json   — the synthesized + hand-editable Brief for this cwd
```

Path helper: `briefPath(cwd)` in `projectBrief.cjs` — `<cwd>/session-manager-operations/project-brief/brief.json`.

## Required shape

```ts
{
  version: number,
  synthesizedAt: string,        // ISO timestamp of the last LLM synthesis
  editedAt: string | null,      // ISO timestamp of the last hand-edit, or null if never edited
  model: string,                // pinned model alias used for synthesis (currently 'sonnet')
  purpose: string,
  what: string[],
  areas: string[],
  scope: string[],
  conventions: string[],
  pins: { what: boolean, conventions: boolean },
  pinned: { what: string[] | null, conventions: string[] | null },
}
```

`pins`/`pinned` implement the generate-and-maintain loop: pinning a block (`project-brief:set-pin`)
freezes its current content into `pinned[block]`; the next `refresh()` synthesis is instructed to
return that pinned block verbatim rather than rewriting it (`buildSynthesisPrompt`'s
`pinnedBlocks` section in `projectBriefCore.cjs`). A hand-edit via `update()`
(`project-brief:update`) auto-pins whichever block it touched, for the same reason — an edit that
isn't pinned would just get overwritten by the next refresh.

## Ownership

Sole writer per `src/main/lib/opsOwnership.cjs`'s `OWNERS` table: **`project-home`**. Every write
path in `projectBrief.cjs` (`refresh()`, `update()`, `setPin()`) calls
`config.writeJson(briefPath(realCwd), persisted, { writer: 'project-home' })`. There is no
declared delegation into this namespace — no other surface may write `brief.json`.

## How it's regenerated vs. hand-edited

- **Regenerated** (`project-brief:refresh`, cost-gated — only fires on explicit user request):
  gathers CLAUDE.md, Epic goal texts (active + up to 200 most recent archived, from
  `prompt-sessions/`), a recent git log, and a depth-2 `src/` tree, then runs one `claude -p` pass
  (model pinned, hard 180s timeout, `SM_KG_INTERNAL=1` so the prompt-logging hook skips it) to
  produce a new Brief. Any pinned block is fed back into the prompt and returned verbatim rather
  than being rewritten.
- **Hand-edited** (`project-brief:update`): a zero-LLM-cost patch to one or more fields, applied
  directly to the persisted JSON. Auto-pins any `PINNABLE_BLOCKS` field (`what`, `conventions`)
  the patch touches.
- **Read** (`project-brief:get`): returns the current `brief.json` plus a `sources` object (drift
  indicators — has CLAUDE.md/Epics/sessions/git changed more recently than `synthesizedAt`) so the
  UI can prompt for a re-synthesis when the underlying project has moved since the last one.

Every refresh/update/setPin call first widens the write boundary for this cwd
(`config.addAllowedRoot(realCwd)`) so a project with no live PTY (a dormant tab, a chat-only Epic)
can still persist the Brief — this does not widen *ownership*, only the filesystem write boundary
that `config.cjs` separately enforces.
