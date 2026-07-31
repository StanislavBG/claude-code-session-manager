---
title: "Verifier: normalize a leading sleep-wrapper when matching self-recovery retries"
cwd: ~/Projects/session-manager
parallelGroup: 812
estimateMinutes: 15
---

# Goal

`isSelfRecovered()` (`src/main/runVerify.cjs:271-287`) pairs a failed `tool_use` with a later
`tool_use` of the *exactly identical* `description` string that succeeded, to avoid flagging a
transient error the agent already retried past. RCA `745-pr188-ci-lint-docs-integrity` (verdict
`transcript_errors`, this repo's own feedback archive) shows a real, reproducible gap: the run
polled `gh pr checks 188 --repo midt-bg/sigma` while CI was still pending (a `gh pr checks` exit
code >0 while checks are `pending` is normal, documented `gh` CLI behavior, not a bug), first as
`sleep 20 && gh pr checks 188 --repo midt-bg/sigma 2>&1`, got `is_error:true` (exit 8, "pending"),
then switched to `gh run watch <id> --exit-status` to actually wait for completion, and finally
re-ran the bare `gh pr checks 188 --repo midt-bg/sigma 2>&1` (no `sleep` prefix) which succeeded
(`pass`). The run committed real work, pushed, verified CI green, and printed a truthful
`SCHEDULER_VERDICT: PASS` — but because the successful retry's description string didn't byte-match
the original failing one (missing the `sleep 20 &&` prefix), `isSelfRecovered()` didn't pair them,
and the job was flagged `transcript_errors` → `needs_review` anyway.

Loosen the description match narrowly: strip a leading `sleep <N> (&&|;)\s*` wrapper before
comparing, so a retry that drops (or changes) only its own timing wrapper still counts as the same
underlying command for self-recovery purposes. Do not loosen matching in any way that could pair
two genuinely different commands — this must stay a false-failure catcher, not a new blind spot.

# Acceptance criteria

- [ ] `isSelfRecovered()` in `src/main/runVerify.cjs` normalizes both the failing event's `desc`
  and each candidate retry's `description` by stripping a leading `^\s*sleep\s+\d+\s*(&&|;)\s*`
  substring (case-sensitive, matches the shell idiom exactly) before comparing — comparison is
  otherwise still exact string equality on the normalized values, no fuzzy/substring matching
  beyond this one narrow strip
- [ ] Add a `normalizeDescForRecovery()` (or similarly named) small pure helper, exported for
  testing, rather than inlining the regex at both comparison sites
- [ ] Unit test in `src/main/__tests__/runVerify.test.cjs` (extend existing file): a fixture with
  a failing `sleep 20 && gh pr checks 188 ...` tool_use followed by a later successful bare
  `gh pr checks 188 ...` (same command, no sleep prefix) — `isSelfRecovered` now returns `true`
  (regression test for the `745` incident)
- [ ] Existing tests for `isSelfRecovered`/the `transcript_errors` verdict path (if any) still pass
  unchanged — this must not weaken detection of a genuinely different, unrecovered command
- [ ] Unit test proving the strip is narrow: two DIFFERENT commands, one with a `sleep N &&` prefix
  and one without, that are NOT the same underlying command after stripping — `isSelfRecovered`
  still correctly returns `false` (i.e. the normalization only removes the sleep wrapper, it does
  not fuzzy-match unrelated commands)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/main/__tests__/runVerify.test.cjs` passes

# Implementation notes

Read `src/main/runVerify.cjs:271-287` (`isSelfRecovered`) and its two call sites at `:632` and
`:658`/`:675` first. The fix is entirely inside `isSelfRecovered` (or a small helper it calls) —
don't touch the call sites.

Full incident evidence (raw transcript excerpt showing both the `sleep 20 &&`-prefixed failing call
and the bare successful retry) is in
`session-manager-operations/feedback/processed/2026-07-28-rca-745-pr188-ci-lint-docs-integrity-20260728T143.md`
(this repo's own archive) — read it to confirm the exact description strings before writing the
regex, rather than guessing the shell-quoting shape.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it
has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this
PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
before done, the finish-protocol sentinel).

# Out of scope

- Any broader fuzzy-matching of tool descriptions beyond the single leading sleep-wrapper strip
- Changing `isHarnessToolError`'s own exemption list
- Adding a dedicated exemption for `gh pr checks`/`gh run watch` specifically — the general
  sleep-prefix normalization already covers this incident's root cause without special-casing one
  CLI tool
