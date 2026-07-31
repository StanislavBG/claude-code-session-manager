# Code review findings: Workbench links 1–2 (commits 7c4836f / 2d6f1ef)

**Date:** 2026-07-30
**Source:** /develop step-8 code review of PRD 778 (`7c4836f`, dockview panel host) during the workbench watch loop, re-checked against PRD 779's landed commit (`2d6f1ef`).
**Status of blockers:** 3 blocking issues were found in 778's commit in isolation. Two are already fixed by 779's commit; the third is routed into PRD 788's AC as a hard precondition (done — see 788's PRD, "BLOCKER" bullet). This file records the remaining non-blocking items.

## Resolved by 2d6f1ef (recorded for the chain's history, no action)

1. **MainPane zero-height inside `.dv-react-part`** — 778's MainPane relied on `flex-1` inside dockview's plain block box, collapsing the content well to 0px (verified in headless Chromium). 779 dissolved MainPane and wraps every screen in `absolute inset-0` (Workbench.tsx:36), which sizes against dockview's positioned content container. Confirmed rendering via cycle2-coverage e2e (6/6 green at HEAD).
2. **Closing the single tab bricked the shell** — no `onDidRemovePanel` guard in 778; 779 added it (Workbench.tsx:94).

## Outstanding — routed into PRD 788 (blocker there, not here)

3. **React element in panel `params` poisons `api.toJSON()`** — `addPanel({ params: { node: screenNode(...) } })` (Workbench.tsx:74,82). DockviewPanel.toJSON() copies `_params` verbatim; a React element's Fiber backref makes serialization throw. Must be fixed (params = id string, resolve node at render) before 788's persistence work. Added as a leading AC bullet in 788's PRD.

## Open nits (fold into a workbench link or a small cleanup PRD when convenient)

- **layout.ts divergence trap:** `getPanelDefinition` (layout.ts:57-58) reads the module constant `DEFAULT_LAYOUT` while the store holds `panels` as state (layout.ts:43) — the two answers diverge silently the moment the registry becomes dynamic. The store also aliases the exported mutable `DEFAULT_LAYOUT` array rather than copying it, so any in-place mutation rewrites the default. Still true post-779.
- **workbench.css theme gaps:** `--dv-sash-color` / `--dv-active-sash-color` undefined → split handles will be invisible once PRD 780's multi-panel splitting lands (fix no later than 780). `--dv-tab-font-size`, `--dv-tab-margin`, `--dv-tab-close-icon-size`, `--dv-floating-group-border` are consumed with no fallback → invalid at computed-value time.
- **Full dockview.css import:** Workbench.tsx imports the entire 112 KB stylesheet (ten built-in themes) only to override with one custom theme.
- **Workbench.tsx micro-cleanups:** `onReady` is `useCallback([])` closing over first-render `children` (correct only via dockview's effect ordering — a childrenRef removes that coupling); a `useMemo` over three already-stable values; `DEFAULT_LAYOUT[0]` indexed unguarded in one place and with `?.` in another.
- **Commit-message accuracy (process note):** 778's "shell is unchanged behaviorally" was inaccurate — a 32px tab strip and draggable/floatable panel are visible chrome changes. Executor PRDs should describe visible deltas honestly so review targets the right surface.

## Review of 779's commit 2d6f1ef (same reviewer, follow-up pass)

Verdict: not clean — 2 high, 4 medium, 5 nits. Both 778 fixes verified sound (height fix re-confirmed in headless Chromium; onDidRemovePanel guard sound for its case).

**Routed into PRD 780 as a leading "Pre-stage fixes" AC section (done):**
- HIGH: non-terminal screens paint over the 32px dockview tab strip — the `absolute inset-0` screen wrapper positions against `.dv-view` (whole group incl. tab strip) since no intermediate dockview container is positioned; terminal is unaffected only because `renderer: 'always'` uses the overlay container. Live at HEAD on 21 of 22 screens.
- HIGH: one-way focus binding — no `onDidActivePanelChange` subscription, so tab clicks leave `focusedPanelId` stale, and re-clicking the stale screen in the sidebar is a silent no-op (identical-value store write → no re-render). Also mis-gates BroadcastBar/WatchersPopover.
- MEDIUM: terminal tab is closable → unmounts TerminalStage, loses scrollback (PTY reattach is idempotent, so no session-exists failure).
- CLEANUP: actively-misleading doc rot (LeftNav.tsx:10 add-a-screen instructions point at deleted MainPane; screenComponents.tsx headers likewise).

**Resolves itself when 780 stage 2 lands (no action):** panels accumulate as permanent tabs and drag-to-split is already enabled in link 2, contradicting the docblock's "exactly one visible" claim — 780 makes multi-visible official and its cleanup bullet fixes the docblock.

**Surface to the user (unexplained scope creep):** `navGroups.ts:29,44` moves 'system-prompt' from Configure to Workspace — not in 779's PRD or commit message. Revert or bless.

**Nits (fold in opportunistically):** render-phase `ctxRef.current = ctx` mutation (safe only sans StrictMode); `focusPanel` byte-identical unused twin of `openPanel` (the HIGH-2 fix gives it its caller); undisposed `onDidRemovePanel` listener; `Workbench.tsx:110` effect deps assume all non-searchMode ctx fields are stable callbacks; missing test asserting every non-terminal SCREEN_KEY renders non-null from `renderScreenComponent` (the nav:*⊂registry test at layout.test.ts:70-80 is the right shape to copy).

## Also observed during this watch tick (already covered elsewhere)

- PRD 779 was marked **failed** (exit 143) despite its work landing as `2d6f1ef` — SIGTERM'd on its own Playwright-under-xvfb AC step. Two existing feedback items already cover the pattern: `2026-07-30-exit143-after-commit-misclassified-as-failed.md` and the no-interactive-AC-in-PRDs rule. 779's AC was independently re-verified green at HEAD (typecheck, layout.test.ts 10/10, cycle2-coverage 6/6).

## RESOLUTION

**Queued as `812-workbench-review-nits-cleanup`** (this repo's own
`session-manager-operations/scheduler/prds/`). Confirmed the full 778-788 chain has landed
(`queue.json`: all `completed`) and every HIGH/MEDIUM finding from both review passes was already
routed into and shipped via PRD 780's "Pre-stage fixes" section (tab-strip paint-over, one-way
focus binding, terminal-closable scrollback loss, doc-rot cleanup) and PRD 788's leading blocker
bullet (panel `params` serialization). Only the explicitly-deferred "Open nits" / "Surface to the
user" / 779-review "Nits" lists were still unrouted — those are what the new PRD covers: the
`layout.ts` `DEFAULT_LAYOUT` divergence/aliasing trap, the `navGroups.ts` `system-prompt` scope-creep
decision, the `workbench.css` undefined `--dv-*` theme tokens, the full-stylesheet dockview import,
and the five Workbench.tsx micro-cleanups (onReady/childrenRef, focusPanel dup check, undisposed
listener, effect-deps assumption, missing SCREEN_KEY render test).
