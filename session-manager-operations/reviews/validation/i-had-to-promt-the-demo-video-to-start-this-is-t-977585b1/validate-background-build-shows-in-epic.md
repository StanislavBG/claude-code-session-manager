# Validation: background-build-shows-in-epic (PRDs 3116–3119)

Base: 2cc0298bfd19db62029a55d867387991d66d8bec. Commits: 25694ef6 (3116), 5a04ea69 (3117), a96bf0e5 (3118), 41300c91 (3119), plus 4435116e (row artifact fields). PRD files found in prds-archived/. Review tools: /code-review and /security-review not run as separate commands; self-reviewed the diff (path handling, input size, injection).

## macro-build-done-notice (3116) — VERIFIED
- DONE/FAILED text, label fallback, buildOutput: src/main/scheduler.cjs `macroBuildNotice` / `readMacroBuildOutput` / `macroLabelFor` (~3486-3555).
- Notice + buildOutput persisted: src/main/promptSessionEvents.cjs:109-112; type in src/preload/api.d.ts:3014-3018.
- Non-macro PRD unchanged: `macroBuildNotice` returns null without `macroId`; message override and meta spread are conditional (scheduler.cjs ~3615, ~3718).
- Id regex `/^[a-z0-9-]+$/` via MACRO_ARTIFACT_RE, path from `opsPath`, 256 KB stat cap, try/catch → label-only.
- Tests cover all six cases (scheduler-notify-originating-tab.test.cjs:480+). Gate: vitest 2 files, 47 passed; `npm run typecheck` exit 0.

## epic-background-build-status (3117) — VERIFIED
- All four states + non-job Epic: BackgroundBuildStatus.tsx:46-66; 30 s interval cleared on unmount (:38-43).
- isBackgroundBuild via useMacros `m.job` (EpicDetail.tsx, useMemo); mounted in Discussion with `onOpenPrd={openPrdSlug}`; caption prop in EpicIntakeCard.tsx.
- Gate: 5 renderer spec files, 95 passed; typecheck OK; lint:selectors OK (771 files); lint:hooks OK (395 files).

## epic-runs-include-finished (3118) — VERIFIED
- `finishedRuns` = archived `epicPrds` rows without a live slug (EpicDetail.tsx); label `Runs ${runsCount}`; empty state keyed on runsCount; FinishedRunCard shows slug/title/status (failed → failed).
- Tests in EpicDetailPrdsRuns.test.tsx; gate green as above.

## epic-build-result-card (3119) — VERIFIED
- BuildResultCard.tsx: DONE accent card, FAILED red role=alert, Open in Project Home, report toggle reads `prd-result:<slug>:` assistant turn (eventId exists on PromptSessionTranscriptTurn, api.d.ts:1584). ResponseEvent branches only on build-done/build-failed; job-not-queued path untouched.
- promptSessions.ts:260-262 types notice/buildOutput; events are stored whole, so they survive hydration.
- Gate green as above.

## Real-path probe — PASSED
Copied Self's real PRD 827-demo-video-build-mwguqdcvmwz.md and its vid-mwguqdcvt42/meta.json into a temp project (nothing written to Self). Real `parsePrdRaw` output fed to `notifyOriginatingTab` yielded:
`DONE — Demo Video: “Portfolio reasoning, pitched like a startup” is saved (60 s · Animated whiteboard). Watch it in Project Home ▸ Videos.` with `notice: 'build-done'`, `buildOutput {kind:'video', id:'vid-mwguqdcvt42', title:'Portfolio reasoning, pitched like a startup'}`. The parsed PRD carried macroId and artifactPaths correctly.

## Full suite
`npm run test:unit` (SM_* job env unset): 1058 files passed, 10303 tests passed, 1 skipped. No red specs.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - EpicDetail.tsx `openProjectHome`: dispatches the global `sm:navigate` event and ignores `buildOutput`, so the Videos/Pages sub-tab is not preselected. Allowed by the PRD (ProjectHome has no deep link).
  - FinishedRunCard has no run-log link or timing (PRD out of scope).
  - Worktree shows two foreign deleted files (project-pages demo-video/home.html), not this plan's.
