# Validation — safe-draft plan

Base: 851f810a9c423d78d5a6131a9cb3da7c35f4a222 (known). HEAD at review: 98ac91d7.

Commands run (all green): `vitest run` on epicDraft / promptSessions / NewEpicCard / EpicsWorkspace.drafts specs (4 files, 159 tests pass); `npm run typecheck` (exit 0); `npm run lint` (incl. lint:hooks/selectors, exit 0); full `npm run test:unit` — **932 files / 8659 tests pass, 0 failures** (the six Base-red specs are all green at HEAD; no failure outside them).

## epic-draft-fields-helper — VERIFIED
- `isEditableDraft` = proposed && `inboundFeedbackOrigin === null`: src/renderer/lib/epicDraft.ts:28.
- `draftFieldsFromEpic` returns all nine fields; refs from `part==='reference'` sources, injections from `part==='injection'`, agent `|| NO_AGENT`, `developLoop !== false`: epicDraft.ts:32-63.
- `hasDraftContent`: epicDraft.ts:67. Tests (round trip via real composeEpicIntake, legacy, hasDraftContent) in epicDraft.test.ts pass.
- Gate: vitest + typecheck green.

## update-proposed-draft-action — VERIFIED
- Interface + doc comment src/renderer/state/promptSessions.ts:338-357; impl :851-882.
- Throws on unknown id / non-proposed before any `set` (:852-857); null keys dropped, developLoop only kept when false (:859-871); id/claudeSessionId/cwd/status/createdAt/source preserved via `...rest`.
- Persist via `persistActiveIndex`, restore on reject + rethrow (:874-879); `epic_draft_update` audit emitted once (:880). Tests added in promptSessions.test.ts pass.

## new-epic-card-save-draft — VERIFIED (with an Important finding below)
- Props `draftEpic`/`onDraftSaved`, prefill from `draftFieldsFromEpic` (NewEpicCard.tsx:106-150, 199-204); saved refs as removable chips (:820-840).
- `new-epic-save-draft` button left of Start, gated by `hasDraftContent` (:875-883); new mode uses `createPromptSession(... 'NewEpicCard save-draft')`, no approve/send (:420-435); toasts 'Draft saved'.
- Edit mode uses `updateProposedDraft`; Start: save → `approveProposed(id,'NewEpicCard',{openingPrompt,sections})` → `useChat.send`, no mint (:470-492). `new-epic-discard-draft` → `markCompleted(..., 'NewEpicCard discard draft')` (:441-453).
- Errors → `toast.error`, fields intact (catch blocks). Shared `buildIntake` (:371). Tests pass.

## new-epic-card-autosave-on-switch-out — VERIFIED
- Repro test "unmounting a typed new card saves it once as a draft": run against Base 851f810a with HEAD's test file → **FAILS**; at HEAD → passes.
- Unmount cleanup + cwd-change effect use `snapRef`/`cwdChangedFromRef` (NewEpicCard.tsx:502-570), source 'NewEpicCard autosave'; empty card skipped via `hasContent`.
- Edit mode debounce 800 ms (`AUTOSAVE_DEBOUNCE_MS`), unmount flushes, sig comparison avoids no-op writes.
- Cancel/Start/Save/Discard call `markHandled` (clears timer, sets handled) so no write follows Start; failures toast with draft title inside a try/catch (no throw from cleanup).

## epics-workspace-opens-drafts — VERIFIED
- EpicsWorkspace.tsx:288-295 renders `<NewEpicCard key draftEpic onCreated onDraftSaved={handleSelect} onCancel={()=>setSelectedId(null)}>` before the proposed branch; cross-project proposals still reach `EpicDetail` + `EpicApprovalBar` (:296-300).
- New mode `onDraftSaved={handleCreated}` (:287) = setShowNewEpic(false)+setSelectedId — equivalent to the AC's wording.
- EpicsWorkspace.drafts.test.tsx passes (3 required cases). Existing EpicsWorkspace.test.tsx fixtures were adjusted by sibling repair PR 2785.

## doc-human-draft-lifecycle — VERIFIED
- prompt-sessions/README.md:214-220 "Human drafts" paragraph (7 lines) names Save draft, switch-out auto-save, EpicsWorkspace + `isEditableDraft` (src/renderer/lib/epicDraft.ts), `updateProposedDraft` (legal only while proposed), Start Session = the one proposed→active transition, Discard draft = markCompleted, and that title/objective become fixed on session start, not on save.
- Status table `proposed` row (:174) covers saved drafts. No fourth state/flag/field (diff adds only wording).

## Combined-diff checks
- No new Epic status, flag or persisted field: only `epic_draft_update` audit kind (event name, not Epic data). OK.
- No write after Epic became active: `updateProposedDraft` refuses non-proposed; `markHandled` cancels debounce on Start. OK.
- Hooks above early returns: `npm run lint` (lint:hooks) green. Selectors: new `usePromptSessions((s)=>s.updateProposedDraft/markCompleted)` return stable references; lint:selectors green. OK.
- Security: no new IPC, no path handling beyond existing `resolveAttachmentPaths`; nothing secret. (Manual self-review; no automated review skill run.)

## Findings
### Important
1. NewEpicCard.tsx handleSaveDraft (~:458-462): in edit mode, a successful **Save draft** calls `resetForm()` and leaves `handledRef.current = true`, but the card stays mounted (EpicsWorkspace passes `onDraftSaved={handleSelect}` for the same id/key, so no remount). Expected consequence by reading (not exercised in a live UI): the form blanks while the stored draft keeps its content, and further edits are never auto-saved/flushed on unmount because `handledRef` is never reset. Fix: in edit mode skip `resetForm()` and reset `handledRef`/`lastSavedSigRef` after a successful save.
### Minor
2. NewEpicCard.tsx:`savedRefs` seeded once; if the draft is updated from elsewhere the card does not re-seed (by design: `key={epic.id}`), acceptable.
3. Cwd-change autosave only applies in new mode; edit mode relies on the debounce (fine).
