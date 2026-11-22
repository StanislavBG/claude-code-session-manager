# Validation: Task primitive fix wave (fix-1)

Base: 81fda522 (known). Fix commits: d253ce8a (copy via IPC), a4b81c50 (open layout). PRDs found under `prds-archived/` (3533, 3534, 3516).
Diff: TaskDetail.tsx, TasksView.tsx, two vitest files, tasks-shots.spec.ts (+ unrelated login-item commits, not in scope). /code-review and /security-review not run as separate agents; self-review: no new input handling, no secrets, no paths; `copyText` reused, not re-implemented.

## Gate results (re-run, foreground)

- `npx vitest run src/renderer/lib src/renderer/components/tabs/scheduler src/renderer/components/tabs/history`: 141 files, 1242 tests pass (clipboardGuard now green).
- `npx playwright test -c tests/web-ui/playwright.config.ts tasks-shots`: 1 passed (rebuilt dist-web).
- `npm run typecheck`: exit 0. `npm run lint`: exit 0.

## tasks-detail-copy-via-ipc: VERIFIED
- `TaskDetail.tsx:5` imports `copyText` from `lib/clipboard`; copy callback `const ok = await copyText(text)` → info `<label> copied` / error `Copy <label> failed` (diff lines in d253ce8a). `grep navigator.clipboard TaskDetail.tsx` → no match.
- `TaskDetail.test.tsx:87-98` stubs `api.clipboard.writeText` ({ok:true} then {ok:false}); asserts 'PROMPT TEXT'/'OUTPUT TEXT' writes, 'Prompt copied' info toast, 'Copy output failed' error toast.
- clipboardGuard.test.ts passes (in the 1242-test run).

## tasks-view-detail-open-layout: VERIFIED
- Toggle in its own row: `TasksView.tsx` `data-testid="tasks-header"` above `tasks-filters`; test `TasksView.test.tsx` "renders the switch in its own header row" passes.
- Rows: `detailOpen = selectedId !== null`; step/model cells (`tasks-cell-step/-model`) skipped when open; chip+badge in `flex-1 min-w-0 flex flex-wrap` cell; row `pr-2` (>=8px). Unit test asserts absence/presence, classes.
- Spec `tasks-shots.spec.ts` `assertRowsFit`: chip/badge boxes inside `tasks-list` with >=4px right gap; no row scrollWidth>clientWidth; switch x,y equal closed vs open; still writes four PNGs. Passed in light and dark.
- PNGs opened (all four, 1592x1040): in tasks-detail-light/dark the `rate_limited · exit 1 · quota` chip, `error · exit 2` chip and `ran without SM` badge are fully visible with clear margin; the switch sits at the same top-left spot (x≈36,y≈25) as in tasks-list-light/dark. No visual defect found.

## tasks-view-detail: VERIFIED (copy criterion read as corrected)
- Opens on row click with `tasks.get({cwd,id})`; facts, direct badge, prompt/output blocks with sha256 + `-truncated` marker (`TaskDetail.tsx:42-76`, testids at 122, 171, 180); Escape handler `:109`, close button `:136`; copy now through `copyText` with error toast; no navigator.clipboard. TaskDetail tests (load, truncated/direct, copy failure, close) pass; typecheck/lint (incl. lint:scroll) green. Gate green.

## Earlier findings
- Important 1 (navigator.clipboard): closed — see copy PRD above.
- Minor 1 (rate_limited chip clipped): closed — tasks-detail-light/dark.png show `rate_limited · exit 1 · quota` whole; spec `assertRowsFit` chip right-edge <= column right − 4.
- Minor 2 (`ran wit` badge): closed — the "ran without SM" badge is whole in the detail shots; spec asserts every `tasks-badge-direct` box inside column. (Note: in the detail shots the badge row is `r-1121b` summary; step/model cells removed to make room.)
- Minor 3 (`error · exit 2` touching edge, overflow): closed — chip clear of the edge in the PNGs; spec asserts >=4px gap and `rows overflowing` equals [].
- Minor 4 (toggle jumps): closed — header row; spec asserts `[swOpen.x, swOpen.y]` equals closed position; PNGs show same place.

## Findings
### Critical
(none)
### Important
(none)
### Minor
(none)
