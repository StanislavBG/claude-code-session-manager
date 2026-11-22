# Validation: MD network view fix list plan

Base: 7e69e865. Gates re-run in a clean worktree: `vitest run src/main/__tests__/projectPages*.cjs src/main/lib/__tests__/{mdNetworkScan,mdDocCensus,mdNetworkLinkParity}` 69/69 pass; `npx vitest run src/renderer` 369/370 files on run 1 (one file failed with `getHotkeyConfig` / `usePageShell()` errors), second full run showed no FAIL (flake, see Minor); `npm run typecheck` green; `playwright md-network-shots + project-home-library-shots` 2/2 pass.

## md-tray-remove-doc-controls — VERIFIED
- MdDocPreview.tsx / MdDocTable.tsx: grep for `onVerdict|onMarkReviewed|recordFolders|docFolders` under src/renderer returns nothing outside one stale-prefs test. Table filters/sorts intact (MdDocTable.tsx:16-24).

## md-tray-remove-state — VERIFIED
- `grep -rn "useMdCuration|CurationTray|CURATION_MODE|composeCurationBrief|EMPTY_CURATION" src` → no hits; `mdCuration` only at ToolsPane.test.tsx:677-678 (a regression test that stale prefs are ignored). `src/renderer/lib/useMdCuration*` do not exist.

## md-tray-remove-ipc — VERIFIED
- src/preload/api.d.ts:3110 `mdNetwork: (payload: { cwd: string })`; src/main/projectPages.cjs:109 `scanMdNetwork(root)`; ipcSchemas.cjs:1068-1069 strict; projectPages.test.cjs:384-385 rejects recordFolders/docFolders.

## md-tray-remove-scan-opts — VERIFIED
- `grep recordFolders|docFolders src` hits only tests asserting they are ignored/rejected (mdDocCensus.test.cjs:114-116, mdNetworkScan.test.cjs:491, projectPages.test.cjs:384-385, remoteIpcDispatch.test.cjs:282-288, ToolsPane.test.tsx:678) and a comment (ipcSchemas.cjs:1069). No production use. Heuristic tests pass.

## md-fix-list — VERIFIED
- MdFixList.tsx:76-92 ranks duplicate → broken-link → orphan; row text `Same text in a and b (n shared runs)` / `Keep it in K; link to it from O` (:80-86), `Full copy: keep one.` (:87), `Works only on this machine: <t> is not tracked in git.` (:60). Keeper = topic doc then higher linkedFrom (:41-47). MdLinkMap.tsx:538,552 renders it; MdFindings gone; ToolsPane.tsx:107 uses `fixListCount`. Screenshot shows the duplicate rows first.

## md-history-line — VERIFIED
- Landed in 8f28970d (the PRD file still sits in prds/, not archived). MdLastReview.tsx:~160 renders `Last review <date> · <mode> · <n> runs`, Open record, Run drift check when due; no-record text `No review yet — Run review starts one.`; ToolsPane no longer references REVIEW RUNS (grep). Screenshot shows the no-record line.

## md-kind-labels-map — VERIFIED
- MdLinkMap.tsx:302-308 LEGEND = Map, Folder note, Topic doc, Finding, Missing; collapse only for `column > 1` (:154); MdNetworkExplorer.tsx:284/293 `Graph` / `List`.

## md-kind-labels-docs — VERIFIED
- MdDocTable.tsx:16-24 filter labels as specified; MdDocPreview.tsx:20-26 ROLE_LABEL as specified.

## md-network-shots — VERIFIED (with visual findings)
- Spec asserts 4 rows in duplicate,duplicate,broken-link,orphan order; wrote review-md-network-light/dark/explorer-graph.png (test-results/, gitignored). Opened all three; see findings.

## Findings

### Critical
none

### Important
none

### Minor
1. Fix-list row text wraps mid-word in `.break-all`: "(14 sha / red runs)" in the first duplicate row (light + dark PNGs, FIX LIST card). `break-all` on `md-fix-where` (MdFixList.tsx, the `md-fix-where` span) breaks inside a word; use `break-words`/`[overflow-wrap:anywhere]` only for the path, not the sentence.
2. The duplicate row's `Open` opens the *other* doc only (MdFixList.tsx `open: other`); nothing marks which path it opens. Ambiguity, not a defect in the shot.
3. Link map has large empty area: right half of the card and ~300px below it are blank; the "docs/local-notes.md" and "notes/ · 2" nodes sit alone on the right (all screens). Empty-state looks sparse but nothing clipped.
4. Dark mode is an inverted render (`filter: invert(1) hue-rotate(180deg)`), not a real dark palette: the selected Tools tab becomes a light pill with dark text, honey duplicate tags become dark brown with low-contrast text ("duplicate" tag on dark brown, dark PNG), and the "orphan" tag is low contrast. Readable overall, but it does not prove the app's dark theme.
5. Explorer Graph PNG: the right inspector shows only the empty hint, doc edge label "docs/architecture.md" is overlapped by the curved edge from src/CLAUDE.md (strike-through look at ~(330,530)), and the modal title bar covers the page's Tools tab header partially (backdrop shows clipped "Pages"/"Videos" cards behind the modal, expected for an overlay). Findings count in explorer header (2) differs from the pane (4) — it counts only scan findings, not duplicates.
6. In the light PNG the Link map hint "Hover a doc…" and the 4-finding banner coexist with the one-line history; spacing is fine, no clipped text elsewhere.
7. Flaky renderer suite: one of two full `vitest run src/renderer` runs failed one file with `Cannot read properties of undefined (reading 'getHotkeyConfig')` / `usePageShell() must be used inside a <PageShell>`; the second run was clean. Test not identified (output not captured); likely an unmocked-window.api race — needs a rerun to pin.
8. PRD md-history-line is still in prds/ rather than prds-archived/ although its commit landed (8f28970d): queue bookkeeping, not code.
9. ToolsPane.test.tsx:677 keeps the string `mdCuration`, so the AC grep `mdCuration under src/` is not literally empty; it is a deliberate regression test.
