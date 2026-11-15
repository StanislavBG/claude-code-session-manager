# Validation: phone-transcript-stick-to-bottom (PRD 3167)

Base: 989bdb7f. Commit: b27847f3 (touches only SessionScreen.tsx + the new spec). Review tools: self-review of the combined diff (no background agents).

## phone-transcript-stick-to-bottom — VERIFIED

- AC1 (follow only within 80px or after own send): `SessionScreen.tsx:15` STICK_PX=80; `:160` onScroll stores atBottom; `:173-175` scrolls only if `atBottom.current || justSent.current`; `:113` handleSent sets justSent. Spec tests at `session-transcript-scroll.spec.tsx:76,89,102`.
- AC2 (Load earlier keeps place): `:94` saves scrollHeight/scrollTop before prepend; `:169-172` sets scrollTop = saved.scrollTop + (scrollHeight − saved.scrollHeight). Spec `:114`.
- AC3 (first load opens at newest): atBottom ref starts true (`:61`); spec `:68`.
- AC4 (spec exists, jsdom, defineProperty on scrollHeight/clientHeight/scrollTop, socket-driven): `spec:44-49`, 5 tests.
- Gate re-run: `npm --prefix web/remote-app test -- <3 specs>` → 3 files, 23/23 passed; `npm --prefix web/remote-app run typecheck` → exit 0.
  Environment note: the job worktree had no `web/remote-app/node_modules`; I symlinked the main checkout's (gitignored, uncommitted).

## Findings

### Critical
- none

### Important
- none

### Minor
- `SessionScreen.tsx:166-176`: if the reader is scrolled up when a send happens and the transcript later grows, `justSent` is consumed by the first effect run (the pending bubble render), so a later reply while scrolled up is not followed. This matches the PRD's intent; noted only.
- `SessionScreen.tsx:94`: `prepend` is set only when the page is non-empty; if all of it is duplicates the saved offset is applied against an unchanged height (no-op, harmless).
- Security self-review: no input handling, secrets, or paths involved; pure DOM scroll logic.
