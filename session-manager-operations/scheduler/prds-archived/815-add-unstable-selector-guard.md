---
title: Add preventive check for unstable zustand selectors
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

This repo has hit the "selector mints a fresh array/object on every getSnapshot
call → zustand v5's `useSyncExternalStore` sees a new reference every render →
infinite re-render → React error #185 → blank app" bug THREE times now: TabBar
(see its header comment), an earlier e2e blank-app incident, and the v0.39.0 boot
blank-screen fixed in commit `4ab267b` (see
`session-manager-operations/feedback/processed/2026-07-30-rca-v0390-blank-screen-unstable-selector-185.md`,
follow-up item 2). A repo-wide grep confirms no live instances remain in
`src/renderer` today, but nothing currently guards against a 4th recurrence.
Add a lightweight, fast, repo-local check for this specific pattern.

# Acceptance criteria

- [ ] Check this repo's existing lint infra first: is there an `.eslintrc*` or
      `eslint.config.*` and an `eslint` devDependency in `package.json`? If yes,
      add a small custom ESLint rule (or reuse `eslint-plugin-react-hooks`/a
      no-new-object-in-selector-style rule if one already fits) that flags a
      zustand store hook call (`useScheduleState(...)`, `useLiveTab(...)`,
      `useConfig(...)`, `useVoice(...)`, `usePromptSessions(...)`, `useToast(...)`,
      or similar `use*State`/`use*` hooks backed by zustand — grep
      `src/renderer/state/*.ts` for the actual store hook names) whose inline
      selector arrow body contains `?? []`, `?? {}`, `.filter(`, `.map(`, or
      `Object.values(` directly (not wrapped in `useShallow`).
- [ ] If NO eslint infra exists in this repo, do NOT introduce a whole new eslint
      setup just for this — instead add a small grep-based check script at
      `scripts/check-unstable-selectors.cjs` that scans `src/renderer/**/*.{ts,tsx}`
      for the same pattern (a `use*(...)`-shaped call whose arrow-function selector
      body contains one of the flagged patterns, and is not wrapped in
      `useShallow(...)`), and wire it into a new `npm run lint:selectors` script.
- [ ] Whichever approach is used, it must be invocable via a single npm script and
      exit non-zero when a known-bad pattern is present.
- [ ] Verify the check actually catches the bug class: temporarily reintroduce
      `s.snapshot?.jobs ?? []` as an inline selector in
      `src/renderer/components/TerminalChat.tsx` (or wherever the original
      pattern was), confirm the new check fails, then revert the temporary
      change and confirm the check passes clean.
- [ ] Add a one-line note under this repo's CLAUDE.md "Avoid" section pointing at
      the new check and its npm script name (the existing "Returning a
      freshly-built value from a zustand selector" bullet in CLAUDE.md already
      documents the failure class — extend that bullet with the check's name
      rather than duplicating the explanation).
- [ ] The check completes in under 5 seconds (it may run on every typecheck/CI
      pass).
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Store hooks live in `src/renderer/state/*.ts` (`config.ts`, `live.ts`, `voice.ts`,
`scheduleState.ts`, `toast.ts`, plus `usePromptSessions` if defined elsewhere —
grep `src/renderer/state` and `src/renderer` for `create(` from `zustand` to find
every store). The known-good escape hatch is `useShallow` from
`zustand/react/shallow` — see `src/renderer/components/LiveTranscript.tsx` and
`VoiceButton.tsx` for existing correct usage (`useVoice(useShallow(selectCanRecord))`).
A selector wrapped in `useShallow` should NOT be flagged even if it returns a
derived object/array, since `useShallow` does the reference-stability comparison
itself. CLAUDE.md's existing "Avoid" bullet on this topic is in
`/home/bilko/Projects/session-manager/CLAUDE.md` under the "Avoid" section
(search for "Returning a freshly-built value from a zustand selector").

# Out of scope

- Rewriting any existing selectors — the grep already confirmed none are
  currently broken; this PRD only adds the preventive check.
- A full eslint setup if one doesn't already exist in this repo.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that
apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded
commands, verify before done, the finish-protocol sentinel).
