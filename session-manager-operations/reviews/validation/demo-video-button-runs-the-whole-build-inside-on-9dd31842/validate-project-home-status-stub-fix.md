# Validation: project-home status stub fix

Base 90bfe87c. Commits since base: 85baaea2 (only one; touches only ProjectHomeEmptyState.test.tsx). SM_* unset before tests.

## project-home-empty-state-stub-real-api (PRD 2559) — VERIFIED
- beforeEach stub has `schedule.onState`, `macros.{list,onChanged,jobStatus}` exactly as specified (commit 85baaea2 diff, ProjectHomeEmptyState.test.tsx).
- Second test still asserts the three absent strings (test file lines 62-64); its projectPages override unchanged.
- `git diff 90bfe87c..HEAD --stat`: one file changed; nothing under src/renderer/lib/ or components/tabs/.
- Gate: vitest on EmptyState + projecthome/ + lib/projectPages/ → 4 files, 26 tests passed.

## project-home-build-status-line (PRD 2556) — VERIFIED
- Hook useMacroJobStatus.ts: THROTTLE_MS = 2000 (line 12), schedule.onState (58) and projectPages.onChanged (59) subscriptions.
- ProjectPagesSection.tsx: `project-home-job-status` (41), `project-home-job-session` (51), "Building…" labels (34, 135).
- ProjectHome.tsx: useMacroJobStatus(cwd) (35), onOpenSession={navigateToEpic} (59).
- Gate on combined tree: vitest projecthome + projectPages green (above); `npm run typecheck` exit 0; `npm run lint` exit 0.
- Full `timeout 600 npm run test:unit`: 877 files passed, 8278 tests passed, 1 skipped, exit 0 (the earlier 1 failure is gone).

## Findings
- Critical: none. Important: none.
- Minor: useMacroJobStatus still assumes window.api.macros exists (deferred, out of scope in PRD 2559).
