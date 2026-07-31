---
title: Post-mortem commit check before classifying exit-143 as failed; PRD lint for interactive/GUI acceptance criteria
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Two prior runs (`776-chat-queue-primary-layout-swap`, `779-workbench-screens-as-panels`) landed a
correct, fully-working commit and THEN stalled and were SIGTERM'd (exit 143) attempting an
interactive/GUI-rendering acceptance-criterion step (a scripted screenshot capture under
`xvfb-run`, and a Playwright e2e run under `xvfb-run`, respectively) — both hit a tool-use
rejection mid-run and hung until the scheduler killed them. Both were classified `failed` and
stayed `failed` despite the deliverable already existing and passing every other check
(typecheck, full unit suite, and — independently confirmed by a human/interactive re-run — the
e2e suite itself). This PRD implements the two concrete fixes already diagnosed in
`session-manager-operations/feedback/2026-07-30-exit143-after-commit-misclassified-as-failed.md`
(read that file first — it has the full incident writeup): (1) a post-mortem commit check in
scheduler.cjs's run-outcome classifier so an exit-143 run with a landed, AC-relevant commit isn't
silently misclassified `failed`, and (2) a PRD-authoring lint in queueOps.cjs that flags AC/notes
instructing an interactive Electron launch, `playwright electron.launch`, `xvfb-run`, or
screenshot capture — the same lint category as the existing unbounded-loop lint.

# Acceptance criteria

## Commit check (scheduler.cjs)

- [ ] Locate the run-outcome classifier that currently maps `exitCode !== 0` (specifically 143 /
      SIGTERM) to `failed` (grep scheduler.cjs for where `mappedFromSignal`/exit-code-143 handling
      lives, and for `computeCommittedDuringRun`/`committedInWindow` — the commit-window-attribution
      helpers already exist per `session-manager-operations/feedback/2026-07-30-pass-no-commit-worktree-commit-invisible-at-exit.md`,
      reuse them rather than writing a second commit-detection path)
- [ ] Before finalizing a `failed` classification for an exit-143 (SIGTERM) run specifically, check
      whether a commit landed in the PRD's `cwd` during the run's time window (`startedAt`..`finishedAt`
      from the run's meta.json, same window `committedInWindow` already uses elsewhere). If a commit
      is found: classify the run `needs_review` (not `failed`) with a reason string noting "SIGTERM
      after a commit landed — verify AC before treating as done" rather than silently promoting to
      `completed` (a landed commit doesn't prove every AC line passed, e.g. the interactive step it
      died on) — this differs deliberately from a plain `pass_no_commit` false-negative fix, which
      only needs to flip a boolean; here the AC may be genuinely incomplete, so route to human/`needs_review`
      review rather than auto-completing
- [ ] Do NOT apply this check to non-143 exit codes or to `rateLimited` (already handled separately,
      auto-resumes) — scope this narrowly to "SIGTERM'd but a commit exists," not a general
      reclassification of all failures
- [ ] Unit test in scheduler.cjs's test file (find the existing exit-code/outcome-classifier test
      suite, e.g. grep for `classifyFailureOutcome` or similar in `src/main/__tests__/scheduler*.test.cjs`)
      covering: exit-143 + commit found in window → `needs_review` (not `failed`); exit-143 + no
      commit found → still `failed` (regression check); exit-1/other codes are unaffected

## PRD interactive-AC lint (queueOps.cjs)

- [ ] Locate queueOps.cjs's existing unbounded-loop lint (the PRD content linter mentioned in
      CLAUDE.md's "queueOps.cjs — scheduler PRD queue linter") and add a sibling check: scan a PRD's
      body (Acceptance criteria + Implementation notes sections) for patterns indicating an
      interactive/GUI-rendering step used as a headless AC — at minimum: `xvfb-run`, `playwright test`
      combined with no prior typecheck-only framing, `electron.launch`, `launch the app`, `click
      through`, `screenshot` — tune the pattern list against the two real incidents (776, 779) so it
      would have caught both without also flagging legitimate mentions (e.g. a PRD's Out-of-scope
      section explicitly saying NOT to do this, like the ones just edited in PRDs 780/787/788, must
      not trigger a false positive — the lint should key off imperative/AC-checkbox context, not any
      occurrence of the word "screenshot" anywhere in the file)
- [ ] Lint result surfaces the same way the unbounded-loop lint does today (check queueOps.cjs's
      existing output/reporting shape and match it — a warning attached to the PRD slug, not a hard
      block that prevents queueing, since some interactive mentions may be legitimate context/out-of-scope
      notes rather than actual AC)
- [ ] Unit test covering: a PRD with `xvfb-run`/`playwright test` as an AC checkbox line is flagged;
      a PRD merely mentioning "do NOT run under xvfb" in its Out-of-scope/notes prose is NOT flagged
      (the false-positive case that must not regress); a clean PRD with only typecheck/vitest AC is
      not flagged

## Tests

- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run` for whichever test files were touched/created above passes

# Implementation notes

Read first: `session-manager-operations/feedback/2026-07-30-exit143-after-commit-misclassified-as-failed.md`
(the full incident writeup and the two proposed levers this PRD implements),
`session-manager-operations/feedback/2026-07-30-pass-no-commit-worktree-commit-invisible-at-exit.md`
(the existing `committedInWindow`/`computeCommittedDuringRun` machinery to reuse for the commit
check — do not re-implement commit-window detection), `src/main/scheduler.cjs` (search for
`mappedFromSignal`, `classifyFailureOutcome`, `isNotifiableTerminalStatus`, and the exit-code
handling in the job-completion path — read enough surrounding code to know exactly where the
143-specific branch belongs), `src/main/queueOps.cjs` (the existing unbounded-loop lint — mirror
its structure/output shape exactly for the new check, per this repo's API-reuse standard: one
lint mechanism, two rule sets, not two parallel lint frameworks).

This PRD's own two prior sibling incidents (776, 779) are the test fixtures — their actual run
directories under `~/.claude/session-manager/scheduled-plans/runs/2026-07-30T23-02-22-683Z/` and
`~/.claude/session-manager/scheduled-plans/runs/2026-07-30T23-22-44-669Z/` are real exit-143 runs
with a commit in the window; feel free to read their meta.json/verdicts.json as ground truth for
what the classifier should now produce, but do not mutate those historical run directories.

# Out of scope

- Fixing the `pass_no_commit` timing-fragility bug described in the referenced sigma incident —
  that's a different classifier path (non-143 exits), tracked separately if still open
- Preventing the interactive tool-use rejection itself (i.e., making `xvfb-run`/Playwright actually
  work inside a headless `claude -p` job) — out of scope; the fix is "don't author that AC," not
  "make the sandbox allow it"
- Retroactively reclassifying already-completed historical `failed` runs in queue.json/history —
  this PRD only changes future classification behavior

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
