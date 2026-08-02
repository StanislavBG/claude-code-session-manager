---
title: Consolidate Epic Queue toolbar into one "Actions" dropdown + guard against duplicate active Build Epics
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: psess-msase2q4-1
---
# Goal

The Epic Queue toolbar (`src/renderer/components/epics/EpicQueue.tsx`, header around line 714-726) currently shows three separate controls: the split "Build" button + its caret (added by PRD 921/924), and the accent "+ New Epic" button. The user finds this cluttered now that there are two real actions. Replace all of it with a single accent-styled "Actions" button that, on click, expands a dropdown (reuse the existing `RowMenu`/`MenuItem` pattern already used for the per-row action menu, `EpicQueue.tsx:139` onward) listing "+ New Epic" and "Build Project" as menu items. Separately: add a guard so clicking "Build Project" when this project already has an in-flight `build`-tagged Epic doesn't spawn a second one — it should instead select/open the existing one.

# Acceptance criteria

- [ ] The toolbar's `<span className="ml-auto ...">` block (`EpicQueue.tsx` ~line 717-726) is replaced with a single button labeled "Actions", styled with the same accent treatment the current "+ New Epic" button uses (`bg-accent text-white`, `EpicQueue.tsx:721`) — this becomes the one visually prominent toolbar control instead of three
- [ ] Clicking "Actions" opens a `RowMenu` (reuse the existing component/pattern verbatim, anchored to the Actions button like `RowMenuButton` anchors its menu at `EpicQueue.tsx:409` onward) with exactly two items in this order: "+ New Epic" (calls the existing `onNew` prop, same behavior as today's button) and "Build Project" (calls the existing `BuildButton` component's `handleClick` quick-fire path)
- [ ] The discuss-first advanced path (today's right-click / caret — PRD 924) is preserved, not dropped: right-clicking the "Build Project" menu item, OR (if `MenuItem` doesn't already support a secondary action) a distinct "Build Project (discuss first)" third menu item — pick whichever fits `RowMenu`'s actual item model with the least new code; if adding right-click-on-a-menu-item requires real new plumbing in `RowMenu`, prefer the explicit third menu item instead, don't over-engineer the shared menu component for one caller
- [ ] **Duplicate-Build guard**: before creating a new `build`-tagged Epic (both the quick-fire and discuss-first paths), check `usePromptSessions.getState()`'s sessions for the active project's `cwd` for an existing session with `tag === 'build'` and `status !== 'completed'` (per `PromptSession.status: 'proposed' | 'active' | 'completed'` in `state/promptSessions.ts:40`). If one exists: do NOT create a second one — instead call `onSelect(<that session's id>)` to open it, and show a toast (`toast.info` or similar, check `state/toast.ts` for the right call) explaining a Build Epic is already in flight
- [ ] "Build Project" menu item is visually/functionally disabled (or shows a distinct 'Open Build in progress' label) when the duplicate-Build guard would fire, mirroring how the existing `BuildButton`'s `disabled` state already handles the no-publish-target case (`EpicQueue.tsx`, the `disabled = !activeTabCwd || !target || creating` line) — extend that same disabled logic with the new in-flight check rather than only handling it at click-time
- [ ] All existing `data-testid`s consumers might depend on (`epic-queue-build`, `epic-queue-build-advanced`) either still resolve to equivalent elements inside the new menu, or are deliberately replaced with new ids AND every test file referencing the old ids is updated in the same PRD — grep `src/renderer` for `epic-queue-build` and `epic-queue-new` (or whatever the New Epic button's existing testid is, check the current markup) before renaming anything
- [ ] `src/renderer/components/epics/__tests__/EpicQueue.test.tsx` (extended by PRDs 921/924) is updated to cover: Actions menu opens with 2-3 items, New Epic item still calls `onNew`, Build Project item still creates+sends/drafts as before, and the new duplicate-guard case (an existing non-completed `build` Epic present → clicking Build Project selects it instead of creating a new one, no second `createPromptSession` call)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/renderer/components/epics/__tests__/EpicQueue.test.tsx` passes

# Implementation notes

Read the current `BuildButton` component in full (`EpicQueue.tsx`, roughly lines 38-141) and the toolbar JSX around line 714-726 before starting — this PRD restructures both, not just one. `RowMenu`/`MenuItem`/`RowMenuButton` (`EpicQueue.tsx:139` onward, and `useRowMenuItems` at line 337) is the existing dropdown pattern already used for per-row actions (rename/duplicate/delete/reopen) — reuse it rather than building a second dropdown implementation; if `MenuItem` needs a `disabled` field added to support the duplicate-Build guard's greyed-out state, that's a small, justified extension of the shared type (check every existing `MenuItem` caller isn't broken by an optional new field). Keep `createBuildEpic`/`handleClick`/`handleAdvanced`'s actual logic from `BuildButton` — this PRD moves where they're triggered FROM (a menu item instead of a standalone split button), it does not need to rewrite the Epic-creation sequence itself, aside from adding the duplicate-guard check at the top of both handlers.

# Out of scope

- Changing New Epic's own creation flow/modal
- Adding more than the 2-3 actions described here — this is a consolidation of what already exists, not a place to add new toolbar actions speculatively
- Cross-project duplicate-Build checking — scope the guard to the active project's cwd only, matching how Build Epics are already scoped

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
