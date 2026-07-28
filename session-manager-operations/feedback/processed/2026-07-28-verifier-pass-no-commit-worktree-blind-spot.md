---
title: pass_no_commit still false-flags a worktree-isolated commit despite PRD 674's committedInWindow fallback
source: sigma project (PRD 713 headless run)
type: bug
severity: normal
---

# What happens / what's missing

Run `713-merge-main-feat-network-force-layout` (`~/.claude/session-manager/scheduled-plans/runs/2026-07-28T01-30-49-312Z/713-merge-main-feat-network-force-layout.log`) did exactly what its own PRD prescribed: created an isolated worktree at `/tmp/sigma-pr144-merge` off `fork/feat/network-force-layout`, merged `origin/main`, resolved 4 conflicts, ran the full test/typecheck matrix green, committed `0320209 build: merge origin/main into feat/network-force-layout` on temp branch `pr144-merge-main-1785202267`, pushed it to `fork/feat/network-force-layout` (`4397e19..0320209`, fast-forward), then removed the worktree. `gh pr view 144` flipped from `CONFLICTING` to `MERGEABLE` and CI run `30320727368` completed `SUCCESS` at 01:38:22Z. The run exited 0 with a truthful `SCHEDULER_VERDICT: PASS`.

The run was nonetheless parked in `needs_review` with `.verdicts.json` verdict `pass_no_commit`: `"SCHEDULER_VERDICT: PASS but no commit landed during the run window — the run claims success but produced no code change"`.

This looks like the same class of bug as `2026-07-22-pass-no-commit-false-negative-on-branch-hopping-prd`, which shipped as PRD `674-commit-guard-cross-branch-fallback` (completed 2026-07-26T22:24:35Z) — that fix made the live commit-guard fall back to `committedInWindow()` (`git log --all --since/--until` scoped to `job.cwd`) whenever the fast `gitHead()` diff found nothing. That fallback did not catch this case, because the commit was never made in `job.cwd`'s own repository at all — it was made in a **separate worktree checkout** (`/tmp/sigma-pr144-merge`, added via `git worktree add`), then that worktree was removed before the run ended. If `committedInWindow` runs `git log --all` against `job.cwd` (`/home/bilko/Projects/sigma`) specifically, its ability to see the commit depends on whether the worktree's branch ref and the `fork` remote-tracking ref were actually present/updated in `job.cwd`'s local `.git` at verification time — a `git fetch fork <branch>` run from `job.cwd` after the push is what's needed to make `0320209` visible there (confirmed directly: it was NOT visible before we ran `git fetch fork feat/network-force-layout` in `job.cwd` during this verification pass; `git cat-file -t 0320209` and `git log --all` in `job.cwd` only found it afterward).

# Evidence

- Run log: `~/.claude/session-manager/scheduled-plans/runs/2026-07-28T01-30-49-312Z/713-merge-main-feat-network-force-layout.log`
- Verdict file: `~/.claude/session-manager/scheduled-plans/runs/2026-07-28T01-30-49-312Z/713-merge-main-feat-network-force-layout.verdicts.json` → `{"verdict":"pass_no_commit","reason":"SCHEDULER_VERDICT: PASS but no commit landed during the run window — the run claims success but produced no code change","downgradeTo":"needs_review","sentinel":"pass"}`
- Commit is real and reachable: `git cat-file -t 0320209` → `commit`; `git log --oneline -1 0320209` → `0320209 build: merge origin/main into feat/network-force-layout`; `gh pr view 144 --repo midt-bg/sigma --json mergeable,headRefOid,statusCheckRollup` → `mergeable: MERGEABLE`, `headRefOid: 0320209b0de284b2ac3be20983840d14e2b5f445`, CI check `conclusion: SUCCESS`.
- The commit only became visible from `~/Projects/sigma` (the PRD's `job.cwd`) after this verification pass ran `git fetch fork feat/network-force-layout` there — it was not already resolvable via `git log --all` in `job.cwd` beforehand, which is what `committedInWindow` (PRD 674's fallback, `src/main/scheduler.cjs:210`) checks.
- Prior related items, both already shipped, neither fully covering this: `2026-07-18-needs-review-false-positive-on-externally-completed-prd` → PRD `575-verifier-merge-postcondition-exemption`; `2026-07-22-pass-no-commit-false-negative-on-branch-hopping-prd` → PRD `674-commit-guard-cross-branch-fallback`.

# Suggested direction (optional)

`committedInWindow`'s `git log --all` is necessarily scoped to whatever refs already exist in the repo it's called against. For a dedicated `git worktree add` checkout (the pattern standards.md itself recommends for shared repos like sigma), the commit and its branch are pushed to a remote from the worktree, but nothing forces `job.cwd`'s local remote-tracking refs to update — so the existing fallback can silently miss it. Two independent, composable options, implementer's call:

1. Before running `committedInWindow`, have the live commit-guard do a cheap `git fetch --all --prune` (or fetch just the job's known remotes) in `job.cwd` so any worktree-pushed refs become visible, then re-run the existing `git log --all` scan — reuses `committedInWindow` as-is, just refreshes its input.
2. Treat a `vcs_state_changed`/push transcript event (already emitted in this run's stream-json log at 01:36:04Z) plus a `code_change_published` event as independent commit evidence, OR-ed into `committedDuringRun` the same way PRD 674 OR'd in `committedInWindow`'s result — this doesn't depend on `job.cwd`'s ref state at all.

Either way, keep the existing "no commit anywhere → still correctly flag `pass_no_commit`" regression case from PRD 674 green.

## RESOLUTION

Ours, do it. Root-caused and confirmed live against current code: `committedInWindow()` (src/main/scheduler.cjs:217-230) scopes its `git log --all` scan to `job.cwd`'s local refs only, which never see a commit made+pushed from an isolated `git worktree add` checkout after that worktree is removed — neither PRD 674's cross-branch fallback nor PRD 575's `-merge-main` exemption cover this case. Queued as `715-commit-guard-fetch-fallback-for-worktree-remote-pushed-commi` (PRD 715): add a bounded `git fetch`/OR'd commit-evidence signal so the guard sees worktree-pushed commits, while keeping the existing "no commit anywhere" regression path from PRD 674 green. This is the systemic fix for the 10 duplicate needs_review instances (672, 688, 690, 704 x2, 713 x6) also archived in this pass.
