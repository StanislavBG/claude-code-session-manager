# Validation: sub-menu frame shell plan

Base: fe6387e1 (known). 10 commits in fe6387e1..HEAD, one or more per PRD. Review tools: self-review of the diff (no background agents).

Commands re-run (foreground):
- `npx vitest run` over all 13 PRD test files: 13 files / 46 tests passed (the "usePageShell must be used inside a PageShell" stack is the expected Orphan-throw test output).
- `npm run typecheck` exit 0; `lint:hooks` OK; `lint:selectors` OK; `node scripts/check-scroll-into-view.cjs` OK (423 files).
- `node scripts/frame-integrity.mjs`: exit 0, 12/12 scenarios PASS (Settings General/Permissions/Hooks/Raw, editor preview/split at 1400x900 and 900x650), "Nested scrollers ... none".
- Revert check (local only, files restored from backup, nothing committed): Settings.tsx, EffectiveCards.tsx and Hooks.tsx replaced with their fe6387e1 versions, so frame-integrity exits 1 with `FAIL settings/General @1400x900` and `@900x650`. Each rail click names `div.flex-1.overflow-auto.py-3` as scrolled.

## scroll-within-helper — VERIFIED
`src/renderer/lib/scrollWithin.ts` exports scrollWithin and scrolls only via `container.scrollBy` (line 48). Its test covers the listed cases and the gate passed. No scrollIntoView call remains.

## page-shell-primitive — VERIFIED
`PageShell.tsx:66-91`: root is `h-full w-full flex flex-col overflow-clip`. Header and footer are `shrink-0 overflow-clip`. Subnav (76) and content (85) are the only `overflow-y-auto overscroll-contain` regions. Tests pass.

## settings-general-on-page-shell — VERIFIED
`EffectiveCards.shell.test.tsx`, `Settings.tabs` and `Settings.invalidDraft` pass. The revert check proves the General view is the one that fixes the scroll.

## settings-hooks-raw-on-page-shell — VERIFIED
`Settings.shell.test.tsx` and `Hooks.scenario` pass. frame-integrity passes Permissions, Hooks and Raw.

## doc-outline-scroll-within — VERIFIED
`DocOutline.tsx` calls `scrollWithin(scrollRef.current, el, {block:'start', behavior:'smooth', offset:16})` and has no scrollIntoView. `overflow-clip` is on the `flex h-full` rows and the mode toggles in EditorView and DocumentEditorPane. DocOutline root has `overscroll-contain`. `MarkdownPreview.tsx` was also changed (+1/-1), which I take to be its `overscroll-contain`. Tests pass.

## app-frame-overflow-clip — VERIFIED
`styles.css` uses `overflow: clip` with a comment. Workbench wrapper is `h-full overflow-auto overscroll-contain bg-bg` with `data-testid="panel-host"`. `frameOverflow.test.ts` and the Workbench test pass.

## migrate-scrollintoview-page-callers — VERIFIED
Home, SchedulerTopBands and EpicIntakeCard have no scrollIntoView (repo-wide non-test grep finds none). `scrollToNeedsYou.test.tsx` passes.

## lint-ban-scrollintoview — VERIFIED
The script exits 0. package.json has `lint:scroll`, and `lint` ends with `npm run lint:scroll`. FileTree and CommandPalette are migrated.

## frame-integrity-check — VERIFIED
`check:frame` is in package.json. The script exits 0 and reports 12/12 passes plus the nested-scroller report. It fails when the Settings fix is reverted (see above). The scenarios run at both viewports. I did not separately read the Vite virtual-fixture plugin code; the script ran end to end, so it works.

## doc-page-shell-law — VERIFIED
`CLAUDE.md:155` is the one new Avoid line, and `wc -c CLAUDE.md` is 12000 (the limit is 12000). `conventions.md:103` has the incident entry with the 193px/84px numbers and the fix. `src/renderer/CLAUDE.md:25` names PageShell for any page with a sub-menu.

## Findings

Critical: none.

Important: none.

Minor:
- `CLAUDE.md` is exactly at the 12000-char budget. The next added line needs another line removed.
- `scripts/frame-integrity.mjs` logs a `[page error] Event` at 1400x900 and 900x650 on the Hooks scenario. It is non-fatal but unexplained; it is probably a Monaco/worker load in the stubbed fixture.
- The revert check shows the pre-fix failure as an inner page scroller moving, not the outer frame. That is still the intended detection.
- Foreign files `project-pages/home.html` and `demo-video/index.html` show as deleted in this worktree. They were not touched by this plan.
