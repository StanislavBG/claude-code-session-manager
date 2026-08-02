---
title: "Fix: land the Agent Library nav page inline (prior run delegated to a background agent and exited 0 uncommitted)"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 919
estimateMinutes: 35
---

# READ THIS FIRST — the failure this PRD fixes

The previous run of `919-agent-library-nav-page` failed by **delegating instead of executing**.
The canonical rule it broke, quoted verbatim from `plugins/session-manager-dev/skills/develop/standards.md`:

> **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/propose-epic`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue.

**A queued PRD is the task, not evidence of completion. Your deliverable is the code diff and a landed commit.**
Do not spawn a background agent to "do the feature" and then report that you started one. Do the edits yourself,
in this turn, with your own `Read`/`Edit`/`Write`/`Bash` calls.

# Root-cause analysis

Failure log: `/home/bilko/.claude/session-manager/scheduled-plans/runs/2026-08-02T01-20-43-877Z/919-agent-library-nav-page.log`

- The run used only **2 turns** and ~30s of API time. Turn 1 read the PRD; turn 2 called the `Agent` tool
  (`subagent_type: "claude"`, description "Build Agent Library nav page") in the background and ended with the
  literal final result text: *"Started a background agent implementing the full Agent Library feature (nav entry,
  IPC handler, preload bridge, component, tests, code/security review, and commit). I'll report back once it completes."*
- A headless `claude -p` process has **no next turn**. It exited immediately. The CLI then printed
  `Background tasks still running after 600s; terminating` and SIGKILLed the implementation subagent
  mid-`code-reviewer` pass.
- Consequences: **no commit**, **no `SCHEDULER_VERDICT` sentinel**, exit code 0. The scheduler saw a clean exit
  with nothing landed.
- This is the documented "delegated instead of executed" class (standards.md incidents PRD 460 and PRD 479).

**Important collateral state:** the subagent got far enough to write the feature into the working tree before it
was killed. As of the failure, the repo has **uncommitted** changes implementing most or all of this feature:

Untracked (new):
- `src/main/agentLibrary.cjs`
- `src/main/__tests__/agentLibrary.test.cjs`
- `src/renderer/components/tabs/AgentLibrary.tsx`
- `src/renderer/components/tabs/__tests__/AgentLibrary.test.tsx`

Modified:
- `src/main/index.cjs` (new zero-arg IPC handler `agents:list-personas`)
- `src/preload/index.cjs`, `src/preload/api.d.ts` (bridge + types)
- `src/renderer/components/LeftNav.tsx`, `src/renderer/lib/screenKeys.ts`,
  `src/renderer/lib/navGroups.ts`, `src/renderer/components/screenComponents.tsx`,
  `src/renderer/components/learningContent.ts` (nav wiring + PAGE_META + help copy)
- `src/renderer/lib/__tests__/navGroupsHome.test.ts`, `vitest.config.ts` (test wiring)

**So your job is primarily to verify, finish, and LAND this diff — not to rebuild it from scratch.**
Assess what is actually on disk first. If it is complete and green, harden anything missing and commit it.
If parts are missing or broken, finish them inline yourself.

# Original feature requirements (restated, self-contained)

Add a read-only **"Agent Library"** nav page reachable from the Home face's left sidebar, listing every
available agent persona:

- The global definitions in `~/.claude/agents/*.md` — name, description, tools, and the rest of the frontmatter,
  plus the markdown body.
- For each currently-open project TAB, whether that project has a **local overlay** of the same name at
  `<tab-cwd>/.claude/agents/<name>.md`. Per Claude Code's precedence rules the project-local file overrides the
  global definition when both exist, so each persona should list an `overridingProjects` set.

This surfaces the two-layer agent system (global default + per-project overlay) in the app for the first time.

Design/architecture constraints (from this repo's `CLAUDE.md` at the repo root — read it):
1. NavKey wiring must be consistent across `LeftNav.tsx`, `lib/screenKeys.ts`, `lib/navGroups.ts`
   (`NAV_ITEMS` entry, **HOME face only**), and `components/screenComponents.tsx` (routing + `PAGE_META`).
2. `AgentLibrary.tsx` follows the canonical **list+detail** shape modeled on `components/tabs/Skills.tsx`.
   Import shared primitives from `components/ui/` by explicit name.
3. The main-process module parses frontmatter with the repo's **existing** parser
   (`src/main/lib/prdFrontmatter.cjs`'s `splitFrontmatter`) — **do not add a YAML dependency**.
4. All filesystem paths in the main-process module route through `config.cjs`'s `validatePath`
   (home-dir-boundary enforcement). An out-of-bounds cwd must be skipped gracefully, not thrown.
5. IPC payloads are validated at the main-process boundary; the handler is zero-arg.
6. **No unstable zustand selectors** — never return a freshly-built value (`?? []`, `.map`, `.filter`,
   `Object.values`) from a selector. Use a module-level stable constant. This has blanked the whole app three times.
7. Read-only page: no writes to `~/.claude/agents/` or to any `session-manager-operations/` namespace.

# Concrete fix steps

Work inline. Bound every command with `timeout`.

1. **Survey the existing working-tree state** (do this before editing anything):
   ```bash
   cd /home/bilko/Projects/session-manager
   git status --porcelain
   git stash list
   git diff --stat
   ```
   Do **not** stash, reset, or `git clean` — the uncommitted changes here ARE the deliverable.
   (If `git stash list` shows unrelated pre-existing entries, leave them alone.)

2. **Read the new/changed files** and judge completeness against the requirements above:
   `src/main/agentLibrary.cjs`, `src/main/index.cjs` (the `agents:list-personas` handler),
   `src/preload/index.cjs`, `src/preload/api.d.ts`, `src/renderer/components/tabs/AgentLibrary.tsx`,
   `src/renderer/lib/navGroups.ts`, `src/renderer/lib/screenKeys.ts`,
   `src/renderer/components/screenComponents.tsx`, `src/renderer/components/LeftNav.tsx`,
   `src/renderer/components/learningContent.ts`, and both new test files.
   Also read `src/renderer/components/tabs/Skills.tsx` for the canonical shape and
   `src/main/lib/prdFrontmatter.cjs` for the parser contract.

3. **Fix anything incomplete or non-conformant**, specifically checking:
   - The `icon` value used in the `NAV_ITEMS` entry actually exists in the icon map used by `LeftNav.tsx`
     (grep the icon key; an unknown key renders blank). Fix or substitute an existing icon if it doesn't.
   - The `NAV_ITEMS` entry is on the **HOME** face only, not the project face.
   - `PAGE_META` and `learningContent.ts` both have an entry for the new key (missing entries can throw
     or render an empty header).
   - No zustand selector in `AgentLibrary.tsx` returns a freshly-built value.
   - `src/main/agentLibrary.cjs` handles: missing `~/.claude/agents` dir, an empty dir, a file with no
     frontmatter, and a tab cwd that `validatePath` rejects — all without throwing.
   - `vitest.config.ts`'s explicit include list actually covers both new test files.

4. **Run the gates** (bounded, in this order, ending green):
   ```bash
   timeout 300 npm run typecheck
   timeout 120 npm run lint:selectors
   timeout 300 npx vitest run src/main/__tests__/agentLibrary.test.cjs src/renderer/components/tabs/__tests__/AgentLibrary.test.tsx src/renderer/lib/__tests__/navGroupsHome.test.ts
   timeout 600 npm run test:unit
   ```
   If any gate is red, fix it inline and re-run the **same command with the same description** so the
   verifier's self-recovery detector pairs the retry with the earlier failure.

5. **Sanity-check the live data path without launching a second Electron instance.** Do NOT run
   `npm run dev`, `npm run test:e2e`, or otherwise start the app — a second Electron process SIGTERMs
   live scheduler jobs and clobbers `~/.claude/session-manager/admin-api.json`. Instead exercise the
   pure main-process module directly under node:
   ```bash
   timeout 60 node -e "const m=require('./src/main/agentLibrary.cjs'); m.listPersonas().then(r=>console.log(JSON.stringify(r.map(p=>({name:p.name,overridingProjects:p.overridingProjects})),null,2))).catch(e=>{console.error('HALT:',e.message);process.exit(1)})"
   ```
   (Adjust the call to the module's actual export signature; if `listPersonas` takes injectable deps, pass
   the real defaults.) Confirm a `builder` persona appears — both `~/.claude/agents/builder.md` and this
   repo's `.claude/agents/builder.md` exist, so `builder` should list `session-manager` in
   `overridingProjects` **if** a session-manager tab is currently open in the persisted sessions store.
   If no tabs are open, an empty `overridingProjects` is correct and acceptable — say so in your output
   rather than treating it as a failure.

6. **If you want a review pass, run it SYNCHRONOUSLY, inline, before the finish protocol.** Do not
   background a reviewer and end your turn. A review pass is optional here; a green gate plus a landed
   commit is what matters.

7. **Commit the work.** This is mandatory — the prior run's fatal omission.
   ```bash
   git add -A src/main/agentLibrary.cjs src/main/__tests__/agentLibrary.test.cjs \
     src/renderer/components/tabs/AgentLibrary.tsx \
     src/renderer/components/tabs/__tests__/AgentLibrary.test.tsx \
     src/main/index.cjs src/preload/index.cjs src/preload/api.d.ts \
     src/renderer/components/LeftNav.tsx src/renderer/components/learningContent.ts \
     src/renderer/components/screenComponents.tsx src/renderer/lib/navGroups.ts \
     src/renderer/lib/screenKeys.ts src/renderer/lib/__tests__/navGroupsHome.test.ts \
     vitest.config.ts
   git commit -m "feat(nav): Agent Library page listing global agent personas + per-project overlays"
   ```
   Stage **only** the feature's files. Leave `session-manager-operations/` state churn
   (`prompt-sessions/*`, `scheduler/state/*`, `scheduler/prds/.reserved-*`) out of the commit — those are
   runtime state owned by other writers, not part of this change.

8. Re-run the fastest green gate LAST (`timeout 300 npm run typecheck`) so the transcript ends green,
   then emit the finish protocol's verdict sentinel.

# Verification commands

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npm run typecheck
timeout 120 npm run lint:selectors
timeout 600 npm run test:unit
git log --oneline -1
git status --porcelain -- src/            # must show no remaining unstaged feature files
```

Negative assertion — the nav entry must be HOME-face-only. Write it so the clean case exits 0:
```bash
if ! grep -q "agent-library" src/renderer/lib/navGroups.ts; then echo "HALT: nav entry missing"; exit 1; fi
echo "nav entry present"
```

# Acceptance criteria

1. `src/main/agentLibrary.cjs` exists, enumerates `~/.claude/agents/*.md`, parses frontmatter via
   `src/main/lib/prdFrontmatter.cjs`'s `splitFrontmatter` (no new YAML dependency), routes every path
   through `config.cjs`'s `validatePath`, and returns per-persona `overridingProjects` derived from the
   currently-open tabs' `<cwd>/.claude/agents/<name>.md`.
2. A zero-arg IPC handler `agents:list-personas` is registered in `src/main/index.cjs` and bridged through
   `src/preload/index.cjs` with types in `src/preload/api.d.ts`.
3. `src/renderer/components/tabs/AgentLibrary.tsx` renders a list+detail page following `Skills.tsx`'s shape,
   with no unstable zustand selector (verified by `npm run lint:selectors` passing).
4. NavKey `agent-library` is wired consistently in `LeftNav.tsx`, `lib/screenKeys.ts`, `lib/navGroups.ts`
   (HOME face only, with an icon key that exists in the icon map), `screenComponents.tsx` (routing +
   `PAGE_META`), and `learningContent.ts`.
5. `timeout 300 npm run typecheck` exits 0.
6. `timeout 120 npm run lint:selectors` exits 0.
7. `timeout 600 npm run test:unit` exits 0, including `src/main/__tests__/agentLibrary.test.cjs` and
   `src/renderer/components/tabs/__tests__/AgentLibrary.test.tsx` (both present in `vitest.config.ts`'s
   include list).
8. **A commit containing the feature files landed during this run** (`git log --oneline -1` shows it, and
   `git status --porcelain -- src/` is clean for those paths).
9. No background/async subagent was spawned and awaited across turns; all work was performed inline in this run.

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
