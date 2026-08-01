---
title: Wire remaining Epic-auto-mint producers to populate structured source
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msaja8vp-1
dependsOn: [903-epic-distinctness-gate]
---
# Goal

Populate the new `source` field (PRD 902) on the three remaining `ensureEpic()` call sites besides the RCA hook (fixed in PRD 904), so every automated Epic-creation path is equally traceable, not just the one this investigation started from. Sites: `scripts/propose-epic.cjs` (the `/propose-epic` CLI, producer `'propose-epic'`), `scripts/lib/watchdogHelpers.cjs`'s feedback-sweep (producer `'feedback-sweep'`), and `src/main/scheduler.cjs`'s PRD-dispatch join-only call at ~line 4250 (producer `'scheduler-dispatch'` — note this call already passes `mintIfMissing: false` and an explicit `epicId: fm.sourcePromptId`, so it only ever JOINS an existing human-approved Epic and never mints; it still gets a `source` note for symmetry/audit-trail completeness, not because it needs the distinctness gate from PRD 903).

# Acceptance criteria

- [ ] In `scripts/propose-epic.cjs`'s `ensureEpic()` call (~line 44-51), add `source: { producer: 'propose-epic' }` (no further correlating IDs are available at this CLI's call site — it has no PRD slug or run id)
- [ ] In `scripts/lib/watchdogHelpers.cjs`'s `ensureEpic()` call (~line 320-327, the standing 'Inbound feedback processing' Epic), add `source: { producer: 'feedback-sweep' }`
- [ ] In `src/main/scheduler.cjs`'s PRD-dispatch `ensureEpic()` call (~line 4250-4257, `mintIfMissing: false`), add `source: { producer: 'scheduler-dispatch', prdSlug: slug }` (the local `slug` variable already in scope at that call site per the surrounding code read `const candidate = safeSlugPathIn(d, slug)` two lines above) — note per PRD 902's spec this only matters when this call path actually creates a NEW session record; confirm by reading PRD 902's landed `ensureEpic` implementation whether `source` is written/updated on a pure join-only call (`mintIfMissing:false` matching an existing `explicitEpicId`), and if that path is a no-op for `source` (i.e. it never touches an existing session's fields), explicitly note that in your PR/commit rather than silently doing nothing
- [ ] Confirm none of these three sites need PRD 903's `findJoinableEpic`/distinctness-gate behavior changed: `propose-epic.cjs` and `watchdogHelpers.cjs` both already use `reuseByGoal: true` with a fixed, deliberately-reused title ('Inbound feedback processing' / re-proposal-by-exact-title), which is intentional exact-match reuse, not the 'unique title every time' problem PRD 903/904 fixed for the RCA hook — do not change their `reuseByGoal` usage
- [ ] Unit test updates: extend whichever existing test files cover `propose-epic.cjs`, `watchdogHelpers.cjs`'s feedback sweep, and `scheduler.cjs`'s PRD-dispatch-mint path (grep `src/main/__tests__/` and any `scripts/`-adjacent test dir) to assert the new `source` value is passed through to `ensureEpic` in each case
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test files> passes

# Implementation notes

Read PRD 902's landed `ensureEpic()` signature/behavior in `src/main/lib/epicMint.cjs` before starting (this PRD only adds a new named argument at three call sites — it does not change epicMint.cjs itself). Read `scripts/propose-epic.cjs` in full (short file, ~52 lines) and `scripts/lib/watchdogHelpers.cjs` around its `ensureEpic` call (~lines 300-330) and `src/main/scheduler.cjs` around line 4230-4260 for exact current call shapes before editing — quoted line numbers in this PRD are from this investigation session's read and may have shifted slightly by the time PRDs 902-904 have landed; use them as a starting point, not gospel.

# Out of scope

- Any change to reuseByGoal semantics or the distinctness-gate logic itself (PRD 903 already landed it)
- Adding new correlating IDs beyond what's already in scope at each call site (e.g. do not thread a new sourceTabId through propose-epic.cjs's CLI args — that would be a CLI interface change, out of scope for this provenance-only PRD)
- UI display of the source field — still not in scope for this Epic's PRD chain unless a future PRD adds it

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
