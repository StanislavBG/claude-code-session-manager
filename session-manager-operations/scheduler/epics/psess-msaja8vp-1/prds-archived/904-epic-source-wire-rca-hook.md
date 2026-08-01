---
title: Wire RCA hook to join the failing PRD's own Epic instead of minting a disconnected one
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msaja8vp-1
dependsOn: [903-epic-distinctness-gate]
---
# Goal

Fix the concrete bug this Epic was opened to investigate: `src/main/lib/rcaFeedbackHook.cjs`'s `ensureEpic()` call (around line 354) passes only `reuseByGoal: true` with a synthesized, run-specific title (`Root cause: <slug> → needs_review (...)`) — which almost never string-matches any existing Epic's `goalText`, so every RCA proposal mints a brand-new, hard-to-trace Epic even when the failing job (`job.slug`) already belonged to a known Epic (`job.epicId`, present on every scheduler job record per `src/main/scheduler.cjs`'s job shape). This is exactly what happened with PRD 894: its RCA proposal minted an unrelated new Epic instead of surfacing on `two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb`, the Epic PRD 894 actually belonged to. Pass `job.epicId` as `preferEpicId` (from PRD 903's `findJoinableEpic`, consulted inside `ensureEpic`) and populate the new `source` field (from PRD 902) with `{ producer: 'rca-hook', prdSlug: job.slug, runId: job.runId }`.

# Acceptance criteria

- [ ] In `src/main/lib/rcaFeedbackHook.cjs`'s `fileRcaFeedback` (the `ensureEpic(dest.cwd, { goalText: title, tag: 'bug', status: 'proposed', reuseByGoal: true, openingPrompt: markdown })` call, ~line 354), add `epicId: job.epicId || undefined` (only when `job.epicId` is a non-empty string — many jobs may have a null/missing epicId, e.g. legacy PRDs authored before Epic-gating existed) and `source: { producer: 'rca-hook', prdSlug: job.slug, runId: job.runId }`
- [ ] Confirm (read `src/main/lib/epicMint.cjs`'s `ensureEpic` signature as landed by PRD 903) that passing `epicId` here is interpreted as the `preferEpicId` input to `findJoinableEpic` on the mint-fallback path — NOT the pre-existing `explicitEpicId` join-only semantics used elsewhere (e.g. `scheduler.cjs`'s PRD-dispatch call, which throws if the id doesn't exist). If PRD 903 named the param differently than assumed here, use whatever it actually landed — read the file, don't guess from this PRD's text alone
- [ ] When `job.epicId` resolves to a still-open (`proposed`/`active`) Epic, the RCA proposal must join it (append the RCA markdown as this Epic's `openingPrompt` update via the existing `reuseByGoal`-style enrichment path, or as a new `prd_created`/`response`-chain event if that fits the landed 903/902 API better) rather than minting a sibling — verify by reading whichever landed helper actually performs the join and matching its real return contract
- [ ] When `job.epicId` is absent, or points at a `completed`/nonexistent Epic, fall through exactly as today (mint via `reuseByGoal` title-match, or a fresh Epic) — no regression for jobs with no known origin Epic
- [ ] New/updated unit test in whichever test file already covers `rcaFeedbackHook.cjs` (grep for its existing `__tests__` file) asserting: (a) a job with `epicId` pointing at an existing OPEN epic in a fixture `active-index.json` results in that same epicId being returned/joined, not a new one; (b) a job with no `epicId` preserves current mint-or-reuseByGoal behavior (regression guard); (c) the written/joined Epic's `source` field (when newly minted) matches `{ producer: 'rca-hook', prdSlug, runId }`
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the rcaFeedbackHook test file> passes

# Implementation notes

Read `src/main/lib/rcaFeedbackHook.cjs` in full (the whole `fileRcaFeedback` function, ~lines 287-365) and `src/main/lib/epicMint.cjs` as landed by PRDs 902 and 903 (the real `ensureEpic` signature, the real `findJoinableEpic` contract) before writing any code — those two PRDs may have named parameters or return shapes slightly differently than sketched here; the landed code, not this PRD's prose, is the source of truth. `job` in this function is the scheduler queue-job record (see `src/main/scheduler.cjs`'s job field list — grep for `epicId:` in the job object literal to confirm the exact field name and confirm it's populated at the point `fileRcaFeedback` is called, i.e. by the time a job reaches `needs_review`). Grep `src/main/__tests__/` for an existing rcaFeedbackHook test file to extend rather than create a new one.

# Out of scope

- Wiring propose-epic.cjs, watchdogHelpers.cjs, or scheduler.cjs's PRD-dispatch ensureEpic call — that is PRD 904 (epic-source-wire-remaining-producers)
- Changing what triggers a needs_review classification, or the RCA markdown content itself — only the Epic-targeting and source-tagging behavior changes here

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
