---
title: "Workbench 3/5: active-panel focus scope, then multiple visible panels"
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Third link of the Workbench chain (depends on PRD 779's landed state: every screen is a registered dockview panel, single-visible routing through `openPanel`/`focusPanel`). Two stages in one PRD, in strict order: (1) introduce an active-panel **focus scope** so window-level keyboard handlers only fire for the focused panel, then (2) enable multiple simultaneously visible panels — drag a panel tab to split the group, side-by-side screens, dockview's native resize splitters. Stage 1 must land first because several screens attach window-level `keydown` handlers that assume "mounted ⇒ visible ⇒ focused"; with two panels mounted they all fire at once.

# Acceptance criteria

## Pre-stage fixes (from code review of 779's landed commit 2d6f1ef — do these first)

- [ ] HIGH — screens paint over the dockview tab strip: `screenNode`'s `absolute inset-0` wrapper (Workbench.tsx:24) resolves against `.dv-view` (the whole group, tab strip included) because none of dockview's intermediate containers (`.dv-react-part`, `.dv-content-container`) establish a positioning context. Net effect at HEAD: the 32px tab strip is visible on the Terminal screen (overlay renderer) but painted over by the opaque `bg-bg` wrapper on all other screens. Fix: `position: relative` on `.dv-react-part` (or the content container) in workbench.css, or switch the wrapper to `h-full overflow-auto`. Verify tabs are visible on a non-terminal screen.
- [ ] HIGH — focus binding is one-way: there is no `onDidActivePanelChange` subscription, so a dockview-initiated activation (tab click, close, drag) leaves `focusedPanelId` stale; concretely, from Terminal click another panel's tab, then click Terminal in the sidebar — `openPanel('terminal')` writes an identical value, no re-render, `mountPanel` never runs, the click is a silent no-op. Subscribe `api.onDidActivePanelChange` → `useLayout.getState().focusPanel(id)` (this finally gives the currently-caller-less `focusPanel` its purpose and is the same wiring stage 1's `usePanelFocus` needs). Add a regression test for the openPanel-same-id path.
- [ ] MEDIUM — the terminal tab's × closes the panel and unmounts TerminalStage (loses scrollback; PTY reattach itself is safe/idempotent). The existing re-add guard only fires at totalPanels === 0. Either `hideClose` on the terminal tab or extend the guard to re-add 'terminal' whenever it is removed.
- [ ] CLEANUP — doc rot from 779's MainPane deletion: LeftNav.tsx:10 still tells contributors to add screens via "SCREEN_KEYS in App.tsx → MainPane.renderScreen" (both wrong — it's lib/screenKeys.ts + screenComponents.tsx now); screenComponents.tsx:29,75 headers still describe MainPane as the host. Fix these three actively-misleading comments; also update Workbench.tsx:39-49's docblock ("exactly one screen visible") which stage 2 below makes false.

## Core functionality (stage 1 — focus scope)

- [ ] A `usePanelFocus(panelId)` hook (or equivalent, exported from layout.ts or a sibling lib) exposes whether a given panel is the workbench's active panel, driven by dockview's active-panel events
- [ ] Every window-level keyboard handler inside a screen is gated on its panel's focus. Known offenders to fix (verify each; there may be more — grep for `addEventListener('keydown'` and `addEventListener('keyup'` under src/renderer/components/tabs): `Keybindings.tsx:124` (capture-phase handler that preventDefault+stopPropagation on EVERY key — an unfocused mounted Keybindings panel must swallow nothing), `Browser.tsx:64` (global Ctrl +/-/0 zoom), `EditorView.tsx:245` (Cmd+S), `FileTree.tsx:303`, `FileTabBar.tsx:51`
- [ ] App-global shortcuts (CommandPalette open, Cmd-P/Cmd-Shift-F in App.tsx) are NOT panel-gated — they stay window-level

## Core functionality (stage 2 — multi-visible)

- [ ] Dockview drag-to-split enabled: a panel tab can be dragged to a group edge to create a side-by-side (or stacked) group; splitter drag resizes; this is the system default layout behavior, no new UI chrome
- [ ] Background-but-mounted panels are now allowed: remove link 2's at-most-one-mounted constraint; heavy screens (EditorView/Monaco, SkillReferenceGraph force-graph, Usage recharts) stay mounted only while their panel exists in the layout — closing a panel unmounts its screen
- [ ] Closing the last panel in the last group immediately reopens the default panel (no empty grid)
- [ ] CommandPalette suppression (`skipForRealInput`, App.tsx:454-473) still suppresses correctly when focus is in an input inside ANY visible panel, including dockview's own tab elements

## Interaction / integration

- [ ] With a Terminal panel and a second screen visible side by side, typing in the terminal is not intercepted by the other panel's handlers (this is the Keybindings.tsx regression the focus scope exists to prevent)
- [ ] `live.ts` per-tab subscribe/unsubscribe refcount (live.ts:125-179) behaves when two mounted consumers share a tabId and one unmounts — the surviving consumer keeps receiving events

## Tests

- [ ] Unit test for the focus-scope hook/store logic (active panel id transitions; handler-gating predicate)
- [ ] Unit test for live.ts refcount: subscribe twice for one tabId, unsubscribe once, assert still subscribed; unsubscribe again, assert torn down
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/layout.test.ts src/renderer/state/__tests__/live.test.ts` passes (create/extend both as needed)

NOTE: do NOT add a `playwright test ... under xvfb` acceptance criterion here. Two prior links in
this chain (776, 779) stalled and were SIGTERM'd (exit 143) on exactly that step — a headless
`claude -p` executor spawning `xvfb-run`/Playwright hits a tool-use rejection and hangs until the
scheduler kills it, even though the underlying command works fine when run outside that harness.
This is a known, documented anti-pattern (see the `feedback_no_interactive_ac_in_prds` memory and
`session-manager-operations/feedback/2026-07-30-exit143-after-commit-misclassified-as-failed.md`).
If e2e coverage matters for this PRD, note it in the completion report as "recommend running
`xvfb-run -a npx playwright test tests/e2e/cycle2-coverage.spec.ts` manually/interactively to
confirm" — do not make it a headless AC line.

# Implementation notes

Depends on PRD 779. Read its landed state first (layout.ts registry + routing, Workbench.tsx) and build on what actually landed.

Read next: `src/renderer/components/tabs/Keybindings.tsx:124` (the capture-phase swallow — the single most dangerous handler; its gating must be airtight), `src/renderer/components/tabs/Browser.tsx:64`, `src/renderer/components/tabs/editor/EditorView.tsx:245`, `src/renderer/components/layout/FileTree.tsx:303` + `FileTabBar.tsx:51`, `src/renderer/App.tsx:454-473` (skipForRealInput), `src/renderer/state/live.ts:125-179` (refcounted subscriptions — likely already correct; the AC is a regression test, not a rewrite).

Dockview exposes `onDidActivePanelChange` — mirror it into the layout store (single writer) and have `usePanelFocus` select from the store, keeping the stores-are-islands convention. Prefer gating handlers at their attach site (skip attach / early-return when unfocused) over a global event interceptor.

Note: the Browser screen hosts a native Electron WebContentsView that paints ABOVE the DOM (Browser.tsx:103-131). Its bounds-sync with dockview drag/float is explicitly a separate follow-up PRD — in THIS PRD it is acceptable for the Browser panel to be visually wrong during an active drag; just ensure its keyboard handlers are focus-gated and its bounds re-sync on drop (the existing ResizeObserver on the placeholder should already fire on final geometry).

# Out of scope

- Browser WebContentsView bounds-sync during drag / hide-when-inactive (dedicated phase-2 PRD)
- Two terminal SESSIONS side by side (Terminal panel identity is per-screen for now; per-session panels are phase 2)
- Floating/pop-out windows
- Layout persistence (link 5)
- xterm refit hardening (link 4)

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
