# Validation: v0.130.0 unit-gate repair plan (PRDs 2778–2783)

Base `851f810a`, HEAD `f6580b64`. Scoped gates re-run in the job worktree; full suite run in a detached throwaway worktree at HEAD (node_modules symlinked, SM_* unset, `env -u SM_CHAT_CONCURRENCY`, fresh TMPDIR).

## repair-page-surface-tests-after-nav-8 — VERIFIED
- `scripts/__tests__/page-surface.test.cjs` retargeted (b0590e91, +30/-?); `npx vitest run` passes (5 files / 34 tests green in combined run).

## repair-api-surface-table-new-preload-methods — VERIFIED
- `src/preload/apiSurface.json` +63 lines (acae0739): 9 entries. Tiers conservative: claudeConfig.read/patch, config.canWrite, plugins.uninstall = deny; setEnabled, setTtsEnabled, removeFromProject = mutate; only getTtsEnabled and plugins.list are read. apiSurface test green.

## repair-library-insert-preset-raw-z-index — VERIFIED
- `Library.tsx:838` uses `${Z.dialog}` (class literal from zLayers). zLayers test green; `npm run typecheck` exit 0 at HEAD.

## repair-telemetry-notice-tests-getconfig — VERIFIED
- Test mock now has `getConfig`; new test "surfaces a toast and does not save when getConfig rejects" asserts `toast.error('boom')` and no setConfig. File green.

## repair-remoteapi-hydrate-sessions-timeout — VERIFIED
- 5ca7f3ac: root cause named (hydrateSessions → resolveStartupCommand awaits `agents.resolveEpicModel`; fake parent never answered it). Fix in test fake only; commit argues real bridge answers read-tier channels from apiSurface. remoteApi test green, no test >5s.

## repair-macro-save-test-ambient-session-env — VERIFIED
- 4608a8d4 clears/restores env in `schedulerMcpServerMacros.test.cjs`. Gate with `SM_CHAT_SESSION_ID=ambient-x CLAUDE_CODE_SESSION_ID=ambient-y`: 18/18 pass.

## Full gate at HEAD f6580b64
- `npm run typecheck`: exit 0.
- `npm run test:unit`: **RED** — 931/932 files pass, 8654 tests pass, 5 fail, all in `src/renderer/components/__tests__/EpicsWorkspace.test.tsx` (preselect most-recent Epic, Mark completed, deep link hydration, queue rows/detail pane, sm:select-prompt-session deep link). `epic-detail` element is null. Deterministic on rerun in isolation.
- Bisect: passes (12/12) at `fd2a620a~1` and at `48117b4d`; fails at HEAD → regression introduced by `fd2a620a` (2774 "open not-started drafts in NewEpicCard edit mode") and/or `d8638ad9` (2773 autosave). Not one of the six repair PRDs.

## Findings
- **Critical** — `src/renderer/components/__tests__/EpicsWorkspace.test.tsx` (5 tests) red at HEAD; v0.130.0 gate is NOT green. Needs a fix (component or test, depends on whether detail pane now legitimately opens drafts differently) before publish.
- Minor — PRDs 2778–2783 lack remaining concerns; page-surface evidence line is by test pass only.

All six repair PRDs landed what they promised; the combined-gate criterion is unmet.
