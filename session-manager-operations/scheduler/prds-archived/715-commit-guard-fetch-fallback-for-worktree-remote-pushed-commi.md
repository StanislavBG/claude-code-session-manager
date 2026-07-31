---
title: Commit-guard fetch fallback for worktree/remote-pushed commits
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

`committedInWindow()` in `src/main/scheduler.cjs:217-230` runs `git log --all --since=... --until=...` scoped to `job.cwd`'s local refs only. When a PRD's own prescribed workflow creates an isolated `git worktree add` checkout elsewhere (e.g. `/tmp/sigma-pr144-merge`), commits and pushes from that worktree, then removes the worktree, the commit never becomes visible in `job.cwd`'s local `.git` unless something fetches it there first. Confirmed live: `git cat-file -t <sha>` in job.cwd only succeeded after manually running `git fetch <remote> <branch>` there. This causes a false `pass_no_commit` verdict even though the run's own `SCHEDULER_VERDICT: PASS` was truthful and the commit is real and merged (`gh pr view` mergeable=true, CI green). This is the same failure class already partially fixed by PRD 674 (cross-branch fallback, scheduler.cjs:210-240) and PRD 575 (merge-main postcondition exemption, ~scheduler.cjs:1930) — neither covers this case because the commit was never made in job.cwd's own repo at all.

# Acceptance criteria

- [ ] Read session-manager-operations/feedback/processed/2026-07-28-verifier-pass-no-commit-worktree-blind-spot.md (after this triage pass archives it) for the full incident narrative before starting.
- [ ] committedInWindow (scheduler.cjs:217) or its caller computeCommittedDuringRun (scheduler.cjs:237) is updated so a commit made+pushed in a separate git-worktree checkout (not job.cwd's own working directory) and then fetched/visible via a remote-tracking ref is correctly detected — implementer's choice between: (a) running a bounded `git fetch --all --prune` in job.cwd before the git log --all scan, or (b) OR-ing in an independent commit-evidence signal (e.g. a vcs_state_changed/push transcript event) into committedDuringRun, per the two options detailed in the feedback file.
- [ ] A new test reproduces the worktree-push scenario (commit exists on a remote-tracking ref not yet fetched into job.cwd, or simulated via a fixture repo) and asserts the verdict is no longer pass_no_commit once the fetch/OR'd signal makes it visible.
- [ ] The existing PRD-674 regression case (genuinely no commit landed anywhere, in cwd or any remote) must still correctly resolve to pass_no_commit — do not weaken that detection.
- [ ] Any added git command (e.g. git fetch) is wrapped with a timeout and never throws, matching this file's existing style (see committedInWindow's own error handling).
- [ ] timeout 300 npm run typecheck passes.
- [ ] The relevant unit test file (locate scheduler.cjs's existing test suite, e.g. src/main/scheduler.test.* or similar) passes: timeout 120 npx vitest run <that file>.

# Implementation notes

Read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` before writing any code — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD; every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

Key files: `src/main/scheduler.cjs:217` (`committedInWindow`), `:232-240` (`computeCommittedDuringRun`, the live commit-guard fallback), `:2646` (call site in the reverify path), `:2495` (`RESCANNABLE_VERDICTS` — pass_no_commit is already rescannable, so a fix here can also self-heal already-parked needs_review jobs on the next reverify pass without extra plumbing). `:2658-2661` shows the existing `pass_no_commit_target_verified` exemption pattern (PRD 575) for reference on how a narrowly-scoped exemption is structured — this PRD's fix should be general (not scoped to `-merge-main` slugs like that one), since a worktree can be used by any PRD, not just merge-main jobs.

Full incident evidence (run log path, verdict file, gh pr view output, exact repro steps) is in `session-manager-operations/feedback/processed/2026-07-28-verifier-pass-no-commit-worktree-blind-spot.md` (this triage pass archives it there) — read it in full before designing the fix rather than re-deriving the scenario from this brief alone.

This PRD is the systemic fix behind 10 duplicate needs_review incidents already self-resolved individually via the scheduler's own auto-fix-PRD pipeline (672, 688, 690, 704 x2, 713 x6, all already `completed` in queue.json) — this is the one deliberate code fix, not a re-litigation of those instances.

# Out of scope

- Re-investigating or re-running any of the 10 already-completed auto-fix PRDs (672-fix-*, 688-fix-*, 690-fix-*, 704-fix-*, 713-fix-merge-main-*).
- Changing the -merge-main postcondition exemption (PRD 575) or the cross-branch HEAD-diff fallback (PRD 674) beyond what's needed to add the new fetch/OR'd signal.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
