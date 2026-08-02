---
title: "Fix: make the builder agent overlay a tracked, committable file and give PRD 922 real acceptance criteria"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 922
estimateMinutes: 25
---

# Context: what the previous run did and why it is being redone

PRD `922-builder-agent-docs-refresh` ran on 2026-08-01 and **exited 0 with `SCHEDULER_VERDICT: PASS`
but zero commits.** Its content edits were actually correct — this fix is NOT about redoing that
prose. It is about making the deliverable auditable and objectively verifiable.

This was **not** a self-delegation failure: the run made no `Skill` / `/develop` /
`/process-feedback` / `ScheduleWakeup` calls. Do not restructure it as one.

## Root-cause analysis

**Cause 1 — both edit targets were outside version control, so no commit could land.**

The previous run edited two files:

- `/home/bilko/Projects/session-manager/.claude/agents/builder.md` (this repo's project overlay)
- `/home/bilko/.claude/agents/builder.md` (the machine-global generic builder agent)

Both are git-ignored:

- In this repo, `.gitignore` line 12 is the bare directory pattern `.claude/`.
  Confirm with: `git check-ignore -v .claude/agents/builder.md` → `.gitignore:12:.claude/`
- In the `~/.claude` repo (which IS a git work tree), `.gitignore` line 4 is `/*`.
  Confirm with: `git -C /home/bilko/.claude check-ignore -v agents/builder.md` → `.gitignore:4:/*`

The scheduler's appended finish protocol requires the run to **commit its work** before printing
`SCHEDULER_VERDICT: PASS`. A run that exits 0 with no landed commit is the single most common cause
of a needless `needs_review` — and worse, it means the edits have no diff, no history, no review
surface, and vanish on any working-tree reset. The previous run correctly *observed* this ("there's
no commit to make") and then declared it the terminal state rather than fixing the tracking gap.

**Cause 2 — the original PRD's `## Acceptance criteria` section was literally empty.**

With no gate command specified, the executor substituted a subjective prose summary of its own edits
as "verification". Nothing objective was ever run, so nothing could have failed. This PRD supplies
real, grep-based, exit-code-bearing acceptance criteria.

**What is already correct on disk (verified — do not redo unless a check below fails):**

- `session-manager-operations/architecture/build-target.json` exists and has shape
  `{ registry, packageName, versionBumpPolicy, gates }` with `gates: ["typecheck", "test:unit"]`.
- `src/main/lib/buildTarget.cjs` exists and exports `resolveBuildTarget` (`module.exports = { resolveBuildTarget }`).
- `plugins/session-manager-dev/skills/builder/3-publish/SKILL.md` exists and documents the
  isolated-worktree publish technique.
- `.claude/agents/builder.md` already points at `build-target.json` / `resolveBuildTarget(cwd)`,
  already reads its gates from that file rather than hardcoding them, already links to the
  `3-publish` SKILL.md, and already states that worktree isolation means a dirty tree does not block
  the release.
- `~/.claude/agents/builder.md` step 2 and step 5 already drop the dirty-tree pause.

# Fix steps

Work in `/home/bilko/Projects/session-manager`. Everything below is in-repo; do **not** try to
commit anything into `~/.claude` (that is a separate repo with its own ignore policy and is out of
scope — see "Out of scope" below).

## Step 1 — un-ignore the project overlay in `.gitignore`

Read `.gitignore`. It currently contains a bare `.claude/` line (line 12). Git will not descend into
an ignored *directory*, so a plain `!.claude/agents/builder.md` negation does **not** work — the
pattern must ignore the directory's *contents* so git can descend, then re-include selectively.

Replace the single `.claude/` line with exactly this four-line block, preserving surrounding lines
and their order:

```
.claude/*
!.claude/agents/
.claude/agents/*
!.claude/agents/builder.md
```

This keeps everything else under `.claude/` ignored (notably `.claude/settings.local.json` and any
other local agent definitions) while making the one file this repo's builder protocol depends on a
tracked, reviewable source file.

Verify the ignore rules do what you intend BEFORE staging anything:

```
timeout 60 git check-ignore -v .claude/settings.local.json ; echo "rc=$? (0=still ignored, expected if the file exists)"
if timeout 60 git check-ignore -q .claude/agents/builder.md; then echo "HALT: builder.md still ignored"; exit 1; fi
echo "builder.md is now trackable"
```

Note: `git check-ignore -q` exits 1 on "not ignored", which is the success case here — that is why it
is wrapped in an `if` rather than run bare (a bare non-zero exit reads as an error to the verifier).

## Step 2 — fix the one real defect in `.claude/agents/builder.md`

The "Publish sequence (once decided)" section ends with the text
`Per the standing [git-publish-autonomy memory], once the decision to publish is made, ...`.
`[git-publish-autonomy memory]` is a **dangling markdown reference link** — there is no matching
`[git-publish-autonomy memory]: ...` definition anywhere in the file, so it renders as literal
brackets. Rewrite that clause as plain prose with no bracket syntax, e.g.:

> Once the decision to publish is made, run that sequence straight through without pausing for
> confirmation at each step — the pause point is the *decision*, not the mechanics.

Do not introduce any other bracketed reference-style links in the file. Keep the existing
inline-style link to `3-publish/SKILL.md` (that one is a valid inline link with a target).

## Step 3 — confirm the overlay's factual claims still hold, and repair any that don't

Run each of these; each must print its OK line. If one fails, fix the overlay text (not the code) so
it matches reality, then re-run:

```
test -f session-manager-operations/architecture/build-target.json && echo "OK build-target.json exists" || { echo "HALT: build-target.json missing"; exit 1; }
grep -q '"packageName": "claude-code-session-manager"' session-manager-operations/architecture/build-target.json && echo "OK packageName" || { echo "HALT: packageName drifted"; exit 1; }
grep -q 'module.exports = { resolveBuildTarget }' src/main/lib/buildTarget.cjs && echo "OK resolveBuildTarget exported" || { echo "HALT: resolveBuildTarget export drifted"; exit 1; }
test -f plugins/session-manager-dev/skills/builder/3-publish/SKILL.md && echo "OK 3-publish SKILL.md exists" || { echo "HALT: 3-publish SKILL.md missing"; exit 1; }
```

Also verify the relative link in the overlay resolves. `.claude/agents/builder.md` links to
`../../plugins/session-manager-dev/skills/builder/3-publish/SKILL.md`; from `.claude/agents/` that
resolves to the repo root, which is correct. Confirm:

```
test -f .claude/agents/../../plugins/session-manager-dev/skills/builder/3-publish/SKILL.md && echo "OK relative link resolves" || { echo "HALT: relative link broken"; exit 1; }
```

## Step 4 — leave a tracked pointer to the global agent file

`~/.claude/agents/builder.md` cannot be committed from this repo. So that a reader of this repo is
not left wondering where the other half of the protocol lives, add a short note near the top of
`.claude/agents/builder.md` (the file already opens by naming `~/.claude/agents/builder.md` as the
generic protocol) making explicit that the global file is **machine-local and not version-controlled
in any repo** — so this overlay is the only tracked half, and any protocol change that must survive
a machine rebuild belongs here or in the `session-manager-dev` plugin skills, not in the global file.
Two or three sentences; do not restate the protocol itself.

## Step 5 — commit

```
git add .gitignore .claude/agents/builder.md
git status --porcelain .gitignore .claude/agents/builder.md
```

Both paths must appear as staged (`A ` for the new file, `M ` for `.gitignore`). If
`.claude/agents/builder.md` does not stage, Step 1's ignore-rule edit is wrong — go fix it rather
than reaching for `git add -f`, which would hide the tracking gap instead of closing it.

Commit with a conventional-commit message, e.g.:

```
git commit -m "fix(agents): track the builder project overlay so its edits are auditable

- .gitignore: un-ignore .claude/agents/builder.md (contents-pattern + negation)
- builder overlay: drop dangling [git-publish-autonomy memory] reference link
- note that ~/.claude/agents/builder.md is machine-local and untracked

Redo of PRD 922, which edited the right content but could not commit it:
both edit targets were git-ignored, so the run exited 0 with no diff."
```

Do **not** run `npm publish`, do not bump the version, do not tag. This PRD changes agent
documentation only.

## Out of scope — do not do these

- Do not edit `~/.claude/.gitignore` or try to commit in the `~/.claude` repo. That repo's `/*`
  ignore policy is a deliberate machine-local choice; changing it is a separate decision.
- Do not move `.claude/agents/builder.md` into `plugins/session-manager-dev/`. Agent resolution
  precedence for a project overlay depends on its `.claude/agents/` location; relocating it would
  change behavior and is not what this fix is for.
- Do not rewrite the substance of either builder file's protocol. The content edits from the
  previous run were verified correct; only the dangling link (Step 2) and the added pointer note
  (Step 4) change.

# Verification commands

Run these in order, in the repo root, as the LAST thing before the finish protocol. All must print
their OK line and the block must end green:

```
# 1. the overlay is tracked
if git ls-files --error-unmatch .claude/agents/builder.md >/dev/null 2>&1; then echo "OK overlay tracked"; else echo "HALT: overlay not tracked"; exit 1; fi

# 2. nothing else under .claude/ got swept in
extra=$(git ls-files .claude/ | grep -v '^\.claude/agents/builder\.md$' || true)
if [ -n "$extra" ]; then echo "HALT: unexpected tracked .claude files:"; echo "$extra"; exit 1; fi
echo "OK only builder.md tracked under .claude/"

# 3. no dangling reference link remains
if grep -n 'git-publish-autonomy memory' .claude/agents/builder.md; then echo "HALT: dangling reference link still present"; exit 1; fi
echo "OK no dangling reference link"

# 4. the overlay still points at the machine-readable config, not hardcoded prose
grep -q 'build-target.json' .claude/agents/builder.md || { echo "HALT: overlay lost build-target.json reference"; exit 1; }
grep -q 'resolveBuildTarget' .claude/agents/builder.md || { echo "HALT: overlay lost resolveBuildTarget reference"; exit 1; }
echo "OK overlay references build-target config"

# 5. the stale dirty-tree blocker is gone from BOTH files
grep -q 'no longer blocks\|does not block\|no longer one of these' .claude/agents/builder.md || { echo "HALT: overlay dirty-tree stance missing"; exit 1; }
grep -q 'no longer necessary\|does not block the release' /home/bilko/.claude/agents/builder.md || { echo "HALT: global agent dirty-tree stance missing"; exit 1; }
echo "OK dirty-tree blocker retired in both files"

# 6. frontmatter intact on the overlay
head -1 .claude/agents/builder.md | grep -q '^---$' || { echo "HALT: overlay frontmatter broken"; exit 1; }
grep -q '^name: builder$' .claude/agents/builder.md || { echo "HALT: overlay name field missing"; exit 1; }
echo "OK frontmatter intact"

# 7. the commit actually landed
if git log -1 --oneline -- .claude/agents/builder.md | grep -q .; then echo "OK commit landed for overlay"; else echo "HALT: no commit touching the overlay"; exit 1; fi

# 8. working tree clean for the two files this PRD owns
dirty=$(git status --porcelain .gitignore .claude/agents/builder.md)
if [ -n "$dirty" ]; then echo "HALT: uncommitted changes remain:"; echo "$dirty"; exit 1; fi
echo "OK this PRD's files are committed"

# 9. repo gates still green (the .gitignore edit must not disturb them)
timeout 300 npm run typecheck || { echo "HALT: typecheck red"; exit 1; }
echo "OK typecheck green"
```

`npm run test:unit` is not required — this PRD touches no `src/` code — but if you choose to run it,
bound it (`timeout 300 npm run test:unit`) and it must be green before you print PASS.

# Acceptance criteria

- [ ] `.gitignore` ignores `.claude/*` but re-includes `.claude/agents/builder.md`, and
      `git check-ignore -q .claude/agents/builder.md` exits non-zero (not ignored).
- [ ] `git ls-files .claude/` lists **exactly** `.claude/agents/builder.md` and nothing else.
- [ ] `.claude/agents/builder.md` contains no `[git-publish-autonomy memory]` dangling reference
      link, and no other bracketed reference-style link without a definition.
- [ ] `.claude/agents/builder.md` still references both `build-target.json` and `resolveBuildTarget`,
      and still links to `plugins/session-manager-dev/skills/builder/3-publish/SKILL.md` via a path
      that resolves from `.claude/agents/`.
- [ ] `.claude/agents/builder.md` contains a short note stating that `~/.claude/agents/builder.md`
      is machine-local and not version-controlled in any repo.
- [ ] Both builder files still assert that an isolated `git worktree` publish means a dirty working
      tree does not block a release.
- [ ] Both files' YAML frontmatter is intact (`---` first line, `name: builder` present).
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] A commit containing `.gitignore` and `.claude/agents/builder.md` landed during this run, and
      `git status --porcelain .gitignore .claude/agents/builder.md` is empty.
- [ ] No `npm publish`, no version bump, no git tag was created.

# Engineering standards

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/propose-epic`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
- **A shared-repo `cwd` can be occupied by a concurrent job — check before you touch shared state.** When a PRD's `cwd` is a repo other headless runs may also target (a shared team repo like sigma, not a private single-purpose project), a `git checkout`/`gh pr checkout` can land you in another job's live worktree with its own uncommitted WIP. Before running `git stash`, `git reset`, or any command that discards or hides working-tree state, check `git stash list` and `git status` first, and if you must set aside pre-existing uncommitted changes that aren't yours, **stash with a descriptive message** (`git stash push -m "pre-existing WIP found by PRD <NN>, not mine"`) and **restore it before your run ends** (or, if you can't safely restore because your own commit depends on that worktree state, leave it stashed with the message and say so explicitly in your finish output — never let the run end silently dropping someone else's stash). Never `git stash drop`/`git clean -fd` on state you didn't create. (Incident: PRD 477 stashed a concurrent job's rAF-throttle-revert WIP to get its own checkout, finished, and exited without restoring it — orphaning the other job's uncommitted work in `stash@{0}` with no record of whose it was.)
- **`gh pr edit --body` can fail on repos with legacy GitHub Projects (classic) boards** — the underlying GraphQL query fetches `repository.pullRequest.projectCards`, a field GitHub is sunsetting, and errors with `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)` even though the edit itself would otherwise succeed. This is a known `gh` CLI quirk, not a defect in your work. Prefer `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body="$(cat body.md)"` for updating a PR description headlessly — it doesn't touch the deprecated field. If you do use `gh pr edit` and it fails this way, don't leave the bare GraphQL error as the last thing in that step (it reads as an unrecovered error in the final-20%-of-transcript verifier heuristic): immediately retry with the `gh api` form and print one line noting the known-bug fallback, so the recovery is adjacent to the error.
- **`gh pr checks`/`gh run watch` exit non-zero while CI is merely *pending*, not failed — don't let that surface as a bare error.** Polling `gh pr checks <n>` before checks finish returns a non-zero exit (e.g. 8) with output like `check  pending  0  <url>` — this is normal, documented `gh` CLI behavior, not a failure. If you retry with a *differently-worded* command (e.g. dropping a `sleep N &&` prefix, or switching to `gh run watch <id> --exit-status`), the verifier's self-recovery detector pairs retries by exact command-description match and may not recognize the differently-worded retry as the same recovery, leaving the original pending-state error looking unrecovered in the transcript (incident: `745-pr188-ci-lint-docs-integrity`, a fully green, committed, pushed run flagged `needs_review` over exactly this). Prefer polling with the *same* command/description each time (e.g. loop `gh pr checks <n>` unchanged, or use `gh run watch <id> --exit-status` from the start rather than switching mid-poll) so a later success is recognized as recovering the earlier pending-state failure.
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). Two executor habits cause it: (1) **throwaway probes that error** — an inline `python -c` with a quoting/f-string slip, a wrong kwarg, a bad path. When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Don't move on leaving a bare error as the last thing in that step. Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner (inline f-string errors are the top source of stranded tracebacks). (2) See the timeout rule below.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** `timeout`-capping a genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is correct — but a bare `Exit code 124` reads as a failure to the verifier. Wrap it so the cap is a success-with-note: `timeout 120 <cmd> || { rc=$?; [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial, rows persist incrementally; OK" || { echo "HALT: <cmd> failed rc=$rc"; exit 1; }; }`. (Distinguish 124 = expected cap from a real non-zero.) For work that legitimately needs longer than a safe cap, run it in the background and poll a bounded number of times rather than capping the foreground command.
- **Polling remote CI/job status: never `sleep N && <cmd>`, and annotate the pending exit code.** The harness hard-blocks a `sleep` chained to another command (`Blocked: sleep 90 followed by: gh pr checks ...`) and that block lands in the transcript as a bare `is_error=true` — usually in the last 20% of the run, right where the verifier weighs errors most. To wait for a remote run, use the tool's own blocking watcher under a hard cap: `timeout 600 gh run watch <run-id> --repo <owner>/<repo> --exit-status`. Also note `gh pr checks` is a **negative-assertion-shaped command**: it exits `8` while checks are pending and `1` when a check failed or none are reported — so the ordinary "still running" path is non-zero. Wrap it so the expected cases print a clean token rather than a bare error: `if out=$(timeout 60 gh pr checks <n> --repo <r> 2>&1); then echo "CI GREEN"; else rc=$?; echo "gh pr checks rc=$rc (8=pending, 1=fail/none) — expected/handled"; fi`. (Incident: PRD 745 fixed PR #188's Lint + Docs-integrity failures, pushed, and CI went fully green — but its `sleep 20 && gh pr checks` (exit 8) and `sleep 90 && gh pr checks` (harness-blocked) sat unannotated at the very end of the transcript and the run was flagged despite a truthful PASS and a landed commit.)
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.
