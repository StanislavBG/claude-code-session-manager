---
title: "Cleanup: PRD 772 code-review nits (dormant-default new sessions)"
cwd: ~/Projects/session-manager
parallelGroup: 812
estimateMinutes: 10
---

# Goal

PRD 772 ("default new project sessions to Chat view", commit `5f1bee5`) was reviewed clean by
code-reviewer with 3 Minor no-behavior/copy-level findings plus one pre-existing issue noted in
passing. Fix all 4 in one small pass.

# Acceptance criteria

- [ ] `src/renderer/lib/createPickedSession.ts:1-11` — the module docstring still describes
  spawning `claude --dangerously-skip-permissions --session-id <uuid>` and "Throws on IPC / spawn
  failures". Rewrite it to describe what the function actually does now: creates a dormant
  Chat-view tab with no spawn; only the `pickDirectory` IPC call can throw.
- [ ] `src/renderer/App.tsx:181` and `:319` — the toast copy "Could not start new session. Is the
  claude CLI on PATH?" can now only fire on a directory-picker IPC failure (the CLI is never
  invoked at tab creation). Reword both call sites to describe the actual failure (directory-picker
  IPC error), not a CLI-on-PATH problem.
- [ ] `src/renderer/state/sessions.ts:137` — when `dormant: true` is passed alongside a non-null
  `startupCommand`, the command is silently discarded. Add a dev-mode `console.warn` (guarded by
  the existing `SM_DEV`/dev-check convention already used elsewhere in this file, if one exists —
  grep the file first) when both are set together, so a future caller notices instead of silently
  losing the command. (A full discriminated-union refactor is optional/out of scope if it would
  touch call sites beyond this file — prefer the smaller warning fix unless the union is a
  same-file, low-risk change.)
- [ ] `src/renderer/lib/useKnownProjects.ts:135` — tabs are tagged `presetId: 'projects-tab'`, but
  no such preset exists in `presets.ts`, so `restartTab`'s `findPreset` fallback always fires for
  these tabs. Confirm this is genuinely a no-op today (fallback behavior is already correct) and
  either fix the mismatched id or leave a one-line comment explaining why the fallback is
  intentional — whichever is true after reading `restartTab`'s fallback logic.
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run` on any existing unit test files covering
  `createPickedSession.ts` / `sessions.ts` (if none exist for these specific lines, note that in the
  completion report rather than adding new test infrastructure — these are copy/docstring/warning
  changes, not new behavior)

# Implementation notes

All four are no-behavior-change (docstring, toast copy, a dev warning, and a naming-mismatch
check/comment) — this is a documentation/DX-accuracy pass, not a feature change. Read each cited
file:line first; don't guess at current content since PRD 772 already landed and file line numbers
may have shifted slightly.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it
has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this
PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
before done, the finish-protocol sentinel).

# Out of scope

- A full discriminated-union refactor of `sessions.ts`'s dormant/startupCommand shape if it would
  ripple beyond this one file's call sites
- Any change to `restartTab`'s fallback logic itself, beyond the one-line fix/comment for the
  `projects-tab` preset id mismatch
