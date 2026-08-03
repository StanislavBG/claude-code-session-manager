---
title: Run each scheduler job in its own git worktree so concurrent jobs cannot corrupt each other
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 90
sourcePromptId: not-enough-paralell-processing-why-i-never-see-3-6a96029e
dependsOn: [finish-protocol-explicit-staging]
---
# Goal

Now that the queue genuinely runs 4-5 jobs wide in one project, N headless agents edit ONE working tree simultaneously. Three concrete failures were observed live on 2026-08-02 with only TWO concurrent writers: a full test run showed 8 failures caused entirely by another job's half-written renderer files; a commit had to be hand-staged to avoid sweeping that job's work in; and one commit was silently rewritten to a new SHA by a concurrent rebase. Give each job its own `git worktree` checkout so its edits, its typecheck/test runs, and its commit are isolated — the same pattern this project already uses for npm publish ("publish from an isolated git worktree, never the live working directory") and that the Agent tool exposes as `isolation: worktree`.

# Acceptance criteria

- [ ] `spawnJob` creates a linked worktree for the job (`git worktree add` on a job-specific branch) and runs the `claude -p` process with that worktree as its cwd, when the job's project is a git repo with a clean-enough base to support it.
- [ ] LOAD-BEARING: the job's PRD file, queue state and run logs must still resolve to the MAIN tree, not the worktree. `<cwd>/session-manager-operations/` is cwd-relative (prdLocations.cjs, queueStore.cjs), so a naive cwd swap would give the job a different, empty ops root and orphan its own PRD. Pass the original project root explicitly and add a test proving the job's PRD is still found and its queue row still updated while it runs in the worktree.
- [ ] The worktree is removed after the job settles, and `git worktree prune` runs so a crashed job cannot leak checkouts. A leaked worktree must not accumulate across app restarts — boot reconciliation prunes stale job worktrees.
- [ ] The job's commit lands on a branch that is then integrated into the base branch (merge or fast-forward), OR the failure to integrate is surfaced as an explicit job outcome. A commit stranded on an abandoned worktree branch is NOT success.
- [ ] The commit guard from the depended-on PRD keeps working across the worktree boundary: a trailer-tagged commit authored in a linked worktree must still be visible to the guard running against the main tree. Test this explicitly — the existing comments at scheduler.cjs:286-320 document two real incidents where worktree commits were invisible at process exit.
- [ ] Disk cost is bounded: a configurable cap on concurrent worktrees, and a documented estimate of disk per worktree for this repo. If the cap is hit, the job runs in the main tree with a logged warning rather than failing.
- [ ] Kill-switch env var (e.g. SM_JOB_WORKTREE_DISABLE=1) restores the current in-place behaviour, following the SM_DOD_DISABLE / SM_SUPERVISOR_DISABLE precedent.
- [ ] A non-git project cwd, or a repo with a dirty base tree, falls back to running in place with a logged reason — never a hard failure.
- [ ] `npm run health` still reports GREEN with the change in place.
- [ ] `npm run typecheck` and `npm run test:unit` pass, plus new unit tests for worktree create/cleanup/prune and the ops-root resolution above.

# Implementation notes

Primary site: `spawnJob` in src/main/scheduler.cjs (the slot acquire is at :2728 and the release at :3168 — worktree lifetime should bracket the same span so a leaked worktree is impossible while a slot is held).

The ops-root hazard is the single most likely way to get this wrong. `session-manager-operations/` is resolved from the job's cwd by `lib/prdLocations.cjs` (resolvePrdsDirs / resolvePrdWriteDir) and `lib/queueStore.cjs`. A prior lesson is recorded in this project's memory as `no_schedule_self_e2e`: "a worktree alone doesn't fix it — the scheduler root is a fixed homedir path". Read `lib/prdLocations.cjs` and `lib/queueStore.cjs` and decide deliberately, per path, whether it should follow the worktree or stay pinned to the project root. Write that decision down in a comment.

Also check `SCHEDULER_CODE_SHA` / `SCHEDULER_BOOTED_AT` (scheduler.cjs:120-131) — they run `git -C __dirname rev-parse`, which resolves against the app's own source, not the job's worktree. Confirm that stays correct.

Prior art to reuse rather than reinvent: the session-manager-dev `builder` skill already publishes from an isolated worktree; the Agent tool's `isolation: 'worktree'` documents the ~200-500ms setup + disk cost per agent. Match that cost model in the disk-cap AC.

Single-writer law (src/main/lib/opsOwnership.cjs) is fail-closed and keyed on the `scheduler` writer — confirm a worktree-run job's writes still declare the same writer and still target the main tree's namespace.

Read the engineering standards file before writing code.

# Out of scope

- Cross-project isolation (jobs in different projects already never share a tree)
- Changing the slot pool or memory gate
- Isolating chat runs (they do not edit the tree)
- Making worktree isolation mandatory — the fallback path must remain

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
