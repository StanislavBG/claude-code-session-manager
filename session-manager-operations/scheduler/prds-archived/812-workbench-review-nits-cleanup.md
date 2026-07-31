---
title: "Cleanup: outstanding Workbench dockview review nits (778/779/780 chain)"
cwd: ~/Projects/session-manager
parallelGroup: 812
estimateMinutes: 20
---

# Goal

The Workbench dockview chain (PRDs 778-788) has landed and all HIGH/MEDIUM findings from its code
reviews were already routed into PRD 780's "Pre-stage fixes" section (confirmed shipped — see
`session-manager-operations/feedback/processed/2026-07-30-prd778-779-review-workbench-dockview-findings.md`).
A handful of Minor/nit findings from those same review passes were explicitly left as "fold into a
workbench link or a small cleanup PRD when convenient" and never got their own PRD. Do that now.

# Acceptance criteria

## Correctness nits

- [ ] `layout.ts` divergence trap: `getPanelDefinition` (`layout.ts:57-58`) reads the module
  constant `DEFAULT_LAYOUT` while the store holds `panels` as state (`layout.ts:43`) — these two can
  silently diverge once the panel registry becomes dynamic. Additionally the store aliases the
  exported mutable `DEFAULT_LAYOUT` array rather than copying it, so any in-place mutation of one
  rewrites the other. Fix: `getPanelDefinition` reads from the store's `panels` state (not the
  module constant), and the store's initial `panels` value is a copy (`[...DEFAULT_LAYOUT]` or
  equivalent), not an alias.
- [ ] `navGroups.ts:29,44` moved `'system-prompt'` from Configure to Workspace during PRD 779 with
  no mention in 779's PRD or commit message (unexplained scope creep, per the review). Verify
  against current `navGroups.ts` whether this placement is still live; if so, either revert
  `'system-prompt'` back to the Configure group or, if Workspace is clearly the better fit given
  what shipped since, leave it and add a one-line comment recording the deliberate placement — pick
  whichever is correct after looking at where `'system-prompt'` is actually used today, and state
  the decision in the completion report.

## Style / theme nits

- [ ] `workbench.css` theme gaps: `--dv-sash-color` / `--dv-active-sash-color` are undefined,
  making split handles invisible now that PRD 780 stage 2 (multi-panel splitting) has landed. Also
  undefined with no fallback: `--dv-tab-font-size`, `--dv-tab-margin`, `--dv-tab-close-icon-size`,
  `--dv-floating-group-border`. Define all five in `workbench.css`'s custom theme block, matching
  the existing token values/palette already used for the other `--dv-*` overrides in that file.
- [ ] `Workbench.tsx` imports the entire dockview stylesheet (all ten built-in themes, ~112 KB) only
  to override with one custom theme. Import only the base/abstract dockview CSS needed for layout
  mechanics plus the custom theme file, dropping the unused built-in theme imports — verify the
  dockview package's docs/exports for the narrower entry point before assuming one exists; if
  dockview only ships the bundled all-themes CSS with no narrower import, note that in the
  completion report and skip this bullet rather than forcing a workaround.

## Micro-cleanups

- [ ] `Workbench.tsx`: the `onReady` callback is `useCallback(..., [])` closing over first-render
  `children` — correct only because of dockview's specific effect ordering. Replace with a
  `childrenRef` (ref updated every render, read inside `onReady`) to remove that fragile coupling.
- [ ] `focusPanel` in the layout store is a byte-identical unused twin of `openPanel` from before
  PRD 780 landed the `onDidActivePanelChange` wiring that finally gave `focusPanel` a caller. Verify
  it now has exactly one real caller (the `onDidActivePanelChange` subscription) and is not still
  duplicated logic — if `openPanel` and `focusPanel` are still identical implementations serving
  distinct purposes (one user-initiated, one dockview-event-initiated), leave both; if one is now
  provably dead code, remove it.
- [ ] The `onDidRemovePanel` listener registered in Workbench.tsx is never disposed (no cleanup
  function calling the dockview event subscription's own dispose/unsubscribe). Add the missing
  cleanup in the same effect that registers it.
- [ ] `Workbench.tsx`'s effect at (search for the `useEffect` with `ctx` in its dependency array,
  originally flagged around line 110 pre-780) assumes all non-`searchMode` fields of `ctx` are
  stable callbacks — verify this still holds post-780 and either confirm it's safe or fix the
  dependency array.
- [ ] Add the missing test: every non-terminal `SCREEN_KEY` renders a non-null result from
  `renderScreenComponent`. Copy the shape of the existing `nav:*⊂registry` test at
  `layout.test.ts:70-80` (per the review's own citation) rather than inventing a new test pattern.

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/renderer/state/__tests__/layout.test.ts` passes (extended with
  the new SCREEN_KEY-render test above)

# Implementation notes

Source document for every bullet above:
`session-manager-operations/feedback/processed/2026-07-30-prd778-779-review-workbench-dockview-findings.md`
(this repo's own feedback archive) — read it first for full context on each finding, including
which review pass (778's or 779's) originally raised it. Read `src/renderer/state/layout.ts`,
`src/renderer/components/tabs/Workbench.tsx` (or wherever it currently lives post-chain — verify the
path, PRDs after 780 may have moved it), `src/renderer/components/layout/navGroups.ts`, and
`workbench.css` before making any change — the chain has had several PRDs land since these findings
were written, so line numbers cited in the source review are approximate; re-locate each by content,
not by trusting the old line number.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it
has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this
PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
before done, the finish-protocol sentinel).

# Out of scope

- Browser WebContentsView bounds-sync during drag (already a separate deferred follow-up per PRD 780)
- Any further dockview feature work (floating windows, named layout presets, etc.)
- Re-litigating any HIGH/MEDIUM finding already shipped via PRD 780 — this PRD is only the leftover
  Minor/nit list
