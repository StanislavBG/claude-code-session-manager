---
title: Process feedback for session-manager
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
---

# Goal

Process the inbound feedback folder for session-manager. The quick-exit (step 0 below)
means this run bails in milliseconds if no open items exist — safe to execute even if
feedback was already cleared between scheduling and execution.

# Acceptance criteria

- [ ] All open feedback items evaluated and either queued via /develop, declined with RESOLUTION, or forwarded upstream.
- [ ] Processed items archived to session-manager-operations/feedback/processed/ (or, for repos not yet relocated, legacy feedback/processed/) with RESOLUTION notes.
- [ ] session-manager-operations/feedback/README.md (or legacy feedback/README.md) self-improved with lessons from this pass.
- [ ] timeout 60 git diff --exit-code runs clean (no uncommitted inline work).

# Implementation notes

Follow the inlined process-feedback procedure below exactly. No skills are loaded in
headless execution — the procedure is fully self-contained. Use /develop for any work
that belongs to this project; never implement feedback inline.

# Out of scope

- Implementing feedback items directly (that is /develop → scheduler).
- Cross-project feedback beyond filing upstream items.

# process-feedback

**Role:** the *agent-side intake* for the dev pipeline — the project-to-project complement of
an interactive human prompt. It evaluates inbound feedback, dispatches the codeable parts to
`/develop` (the shared pipeline), and owns the feedback-specific bookkeeping (status log,
RESOLUTION, archive). It does **not** implement, and it does **not** re-specify how PRDs are
tracked — that lives once, in `/develop` Phase 2.

Work the project's intra-project feedback intake
(`session-manager-operations/feedback/` at the repo root — this is the **one**
canonical name; do not create or treat a differently-named folder like
`external-feedback/` as equivalent, even for cross-service requests — that
split caused ~2.5 weeks of drifted duplicate tracking in burrow before being
merged back on 2026-07-10). Each file is a request from an upstream/downstream
service in the same stack (e.g. Burrow ⇄ signal-builder ⇄ social-signals-trader)
— cross-service origin does not mean a different folder, it's still just
`session-manager-operations/feedback/`. The folder's own `README.md` is the
authority on file conventions — read it first; the steps below are the
process. All session-manager per-project operations live under
`session-manager-operations/`.

**Core principle:** this skill *triages and dispatches*; it does not implement.
Anything that requires writing code for this project is decomposed and queued as
scheduled PRDs through **`/develop`**, which runs them headlessly on the
session-manager scheduler. **process-feedback is done the moment every item is
dispositioned — queued as a PRD, declined, or forwarded — and archived; the
scheduler owns execution from there on.** It does NOT hold items in the inbox
waiting for PRDs to land, and it does NOT babysit the scheduler. Implementing
feedback inline — bypassing the scheduler — is the one thing this skill must not
do.

**Definition of done (resilience contract):** the actionable inbox is empty.
Every open item has been turned into a scheduler PRD (or declined / forwarded
with a reason), given a `## RESOLUTION`, and moved to `processed/`. Archival
happens at **disposition time, not delivery time** — once an item is a queued
PRD, its job is done and the file is archived immediately. The README
status-log **row** (🛠) is the durable execution tracker that lives on after the
file is archived; it is reconciled 🛠→✅ (and failures flagged) by
`/project-status`'s scheduler-PRD audit, cross-referencing the queue — never by
process-feedback blocking on it. A pass that leaves a queued item sitting in the
inbox "until its PRD lands" is the non-resilient bug this contract exists to
prevent.

## Steps

### 0a. Self-migrate a legacy root-level folder first

Before anything else, check for the pre-migration layout: if a legacy
`feedback` folder exists at the repo root **and**
`session-manager-operations/feedback/` does not, relocate it now —
`mkdir -p session-manager-operations` (if needed), then
`git mv feedback session-manager-operations/feedback` when the repo is
git-tracked, else a plain `mv`. This converges any project this skill runs in
to the new layout even if its bulk-relocation PRD hasn't landed yet. Only then
continue with step 0b.

### 0b. Sync open GitHub issues into the intake (source sync)

For a project with a GitHub remote, pull open issues and materialize any not already tracked as a
new feedback file — **before** the quick-exit check below evaluates what's open, since this step
can create new open items that check needs to see. This lets a repo's GitHub issue tracker feed
the same triage → queue pipeline without a human manually copying issues into the feedback folder.

- Skip silently (no error, no report) if `gh repo view --json nameWithOwner -q .nameWithOwner`
  fails — no GitHub remote or `gh` unauthenticated. This step is opportunistic, not required.
- Fetch open issues via `gh api repos/<owner>/<repo>/issues --paginate --jq '...'` (per-issue
  `number,title,body,labels`) rather than `gh issue list`/`gh issue view` — the latter two can hit
  a known `gh` CLI bug on repos with legacy GitHub Projects (classic) boards
  (`GraphQL: Projects (classic) is being deprecated ... (repository.issue.projectCards)`,
  documented in `standards.md`'s Execution discipline section); `gh api` sidesteps it outright by
  never touching the deprecated field. Note `gh api .../issues` also returns pull requests (they
  have an `issue.pull_request` key) — filter those out, this step is issues only.
- **Dedup before creating anything.** An issue already tracked has a feedback file (open OR
  already in `processed/`) containing the token `gh-issue-<N>` — `grep -rl "gh-issue-<N>"
  session-manager-operations/feedback/` (recursive, covers both the inbox and `processed/`) before
  materializing issue `N`. Skip any issue that already has a match.
- For each untracked open issue, create
  `session-manager-operations/feedback/<yyyy-mm-dd>-gh-issue-<N>-<slug>.md` following the folder's
  normal frontmatter convention (see `README.md`):
  - `title`: the issue title, verbatim.
  - `source`: `GitHub issue gh-issue-<N> (<issue URL>)` — the `gh-issue-<N>` token here is what
    the dedup grep matches on next run; don't reword it out.
  - `type`: infer from labels (`bug` label → `bug`; `enhancement`/no matching label → `enhancement`;
    `security` → `security`; `performance` → `performance`).
  - `severity`: `normal` unless the issue's own labels/title clearly indicate `blocker`/`high`
    (data loss, crash, security hole, or an unusable feature with no workaround — same bar as the
    README's own severity guidance; don't inflate).
  - Body: `# What happens / what's missing` = the issue body (verbatim, or a faithful trim if very
    long — don't paraphrase away specifics); `# Evidence` = the issue URL + number, plus any
    screenshot/repro references already in the issue body; `# Suggested direction (optional)` =
    any proposed-solution section already present in the issue body.
- Synced files then flow through steps 1–6 below exactly like any other feedback file — no
  special-casing after creation, same evaluate → queue → disposition → archive pipeline.
- When step 4 dispositions a synced issue by queuing a PRD, the `## RESOLUTION` must also state
  the originating issue number/URL. This skill does **not** auto-close or auto-comment on the
  GitHub issue — that stays a human (or a later, deliberate step) decision once the fix actually
  ships, not something this sync step does on queue.

### 0. Quick-exit — bail in milliseconds if there's nothing to do

**Do this first, cheaply, before reading any code or spawning anything.** This
skill is run on a schedule across many projects (the scheduler's feedback sweep),
so the empty case must cost almost nothing:

- If `session-manager-operations/feedback/` doesn't exist (after the step-0a
  self-migration check) → report "no feedback intake in `<project>`" and
  **EXIT**. (Don't check for or fall back to an `external-feedback/`-style
  variant — `session-manager-operations/feedback/` is the only canonical name.)
- If the folder exists but holds **no open item** (every file is in `processed/`
  or marked ✅/archived; nothing open/🆕) → report "no open feedback in
  `<project>`" and **EXIT immediately**. Do NOT read source, evaluate, or start
  an agent loop.
- Only when at least one **open** item exists do you continue — an open item
  means *someone cares about this project*, so it's worth the full pass (and,
  per step 6, leaving the README better for next time).

### 1. Read the intake

- Read `session-manager-operations/feedback/README.md` (conventions + the status log), then every open/🆕
  file still in the inbox. Under this contract a **🛠 (queued) item has already
  been archived to `processed/`** at disposition time — so anything still sitting
  in the inbox is genuinely un-dispositioned and needs a pass. You will not find
  🛠 items in the inbox to "re-check"; their execution is tracked by the
  status-log row + `/project-status`'s scheduler audit, not by the folder.
- If the folder doesn't exist, say so and stop — don't invent one.

### 2. Evaluate before queueing

For each open item, verify the claims against current code and live data —
feedback cites the state of the world when it was written, which may have
drifted. Then classify each ask:

- **Ours, do it** — the fix belongs to this project. → goes to `/develop`
  (step 3). Do NOT write the code here.
- **Ours, decline** — conflicts with the project's contracts/vision (e.g. a
  convenience ask that violates a service boundary). Decline explicitly in the
  RESOLUTION with the reason; never silently skip. Resolved now (no code) →
  close immediately in step 4.
- **Theirs, forward** — the root cause lives in another service. Do NOT reach
  across the boundary to hack around it; file a feedback or PRD item in *that*
  project's intake folder and reference it (use `/my-feedback to <project>`).
  Resolved now (no code in *this* repo) → close immediately in step 4.

Root-cause with evidence (logs, live queries, health checks), not from the
file's narrative alone — the reporter sees symptoms, you can see causes.

### 3. Queue the work via /develop (never implement inline)

For every **Ours, do it** item, invoke the **`develop`** skill to turn the ask
into one or more self-contained PRDs in the scheduler queue. Hand `/develop` a
complete brief so it does not have to re-ask scope — your step-2 evaluation
already established it:

- The goal, in this-project terms.
- **Acceptance criteria taken from the feedback's own AC**, made verifiable
  (with the test/health command to prove them).
- The absolute `cwd`, plus the exact files/patterns/utilities to reuse that you
  found while root-causing (the API-reuse standard — don't make the headless run
  rediscover them).
- Any constraints, service boundaries, or "out of scope" lines.

`/develop` owns decomposition (small ~15-min PRDs), inlining the engineering
standards, the `NN-` parallel grouping, and — because each PRD publishes its own
work — the implementation **commit + deploy**. That means process-feedback does
**not** commit implementation code; the PRDs do, when they run.

Record the emitted PRD filenames/ids — you need them for steps 4–6.

### 4. Disposition + archive every item now — this is the definition of done

Every open item gets a disposition, a `## RESOLUTION`, and a `git mv` to
`session-manager-operations/feedback/processed/` **in this pass** — archival is at disposition time, not
delivery time. Do NOT leave a queued item in the inbox "until its PRD lands":
that is the drift this contract forbids. By disposition:

- **Queued (Ours, do it):** append `## RESOLUTION` naming the emitted PRD
  filename(s)/id(s) and stating execution is now the scheduler's job. Set the
  README status-log row to **🛠 queued (PRD NN)** (add 🛠 to the legend if
  absent). `git mv` the file (and any `-REPLY`) to `processed/` **now**. The 🛠
  row — not the file's location — is what tracks execution; do not fabricate
  verification for code that hasn't run yet, just record the handoff.
- **Declined (Ours, decline):** append `## RESOLUTION` with the reason (contract
  / boundary conflict), flip the row to ✅, `git mv` to `processed/`.
- **Forwarded (Theirs):** append `## RESOLUTION` naming the upstream filing
  (`/my-feedback to <project>` id), flip the row to ✅ (closed here — the ask now
  lives in their intake), `git mv` to `processed/`.

After this step the actionable inbox is **empty** — only genuinely un-dispositioned
items (still being triaged) may remain, and only within this same pass. Commit the
feedback bookkeeping + any upstream filings in one clean commit (message
references the file id, e.g. `chore(feedback): triage + queue 2026-06-10-01`).
Only commit a clean, green tree; if unrelated in-flight work is mixed into the
working tree, stop and tell the user instead of committing around it.

### 5. Hand off to the scheduler — do NOT babysit

Execution is the scheduler's job from here. **Do not run an interactive watch
loop, and do not block the pass on PRDs landing** — `/develop` already queued
them with the engineering standards inline, the scheduler runs them at its
cadence, and **`/project-status` owns the ongoing audit**: its scheduler-PRD
check cross-references `queue.json` to reconcile each 🛠 status-log row → ✅ when
its PRD lands (the file is already archived), and surfaces any `failed` /
`needs_review` / stuck Burrow PRD. If a PRD later fails, the requester re-files or
the status audit escalates it — the feedback pass does not stay open waiting for
that. If the user wants live progress, point them at the SchedulePanel.

### 6. Self-improve the intake (always do this)

Update the folder's `README.md` guidance section based on what this round
taught you:

- What made an item easy to queue + close? Distill it into a bullet other agents
  can imitate (cite the file as the example) — e.g. a feedback item that already
  carried a crisp, testable AC turned straight into a clean PRD.
- What slowed you down — a missing log path, an unverifiable claim, an ask that
  actually belonged to a third service, a PRD that got stuck? Add the
  counter-guidance.
- Keep the section calibrated and short: merge/rewrite stale bullets rather than
  appending forever.

This step is the point of the skill: every processing pass should make the
*next* pass cheaper.

## Guardrails

- **Never implement feedback inline.** Code that belongs to this project goes
  through `/develop` → the scheduler. The only commits process-feedback makes
  itself are feedback bookkeeping and upstream filings.
- **Archive at disposition time, not delivery time.** The moment an item is
  queued as a PRD (or declined / forwarded), give it a RESOLUTION and `git mv` it
  to `processed/` — do NOT leave it in the inbox waiting for the PRD to land. A
  queued item is archived with a **🛠** status-log row (not ✅); the row is the
  durable execution tracker and is reconciled 🛠→✅ by `/project-status` from the
  scheduler queue. Leaving dispositioned items in the inbox "until they verify"
  is the non-resilient behavior this contract exists to kill.
- **The status-log row is honest about state even after archival.** 🛠 = "PRD
  queued, scheduler owns it, not yet landed"; ✅ = "landed/verified (or
  declined/forwarded)". Never fabricate a ✅ for code that hasn't run — archive at
  🛠 and let the status audit flip it.
- Never delete feedback files to "clear" the folder — archive them.
- Service boundaries outrank feedback asks: an item that requests a boundary
  violation gets a documented decline + an upstream filing, not compliance.
- Report honestly in the RESOLUTION: which PRD id owns the work, what was
  declined/forwarded and why, deps on other teams. An archived item with open
  external deps should say what unblocks it.

## Engineering standards

> Single source of truth for the developer guidance that used to live in the global
> `~/.claude/CLAUDE.md`. Consumers: the `/develop` skill reads it while planning and
> inlines it **verbatim** into every PRD it emits (under an `## Engineering standards`
> heading); the `/prd` command points here for the execution-discipline rules so a
> directly-authored PRD carries the same block. The headless `claude -p` executor sees no
> skills and no conversation — inlining this is the only way these rules reach it. Edit
> here once; every call site updates.
>
> The **Execution discipline** section below is the executor-facing core — it is the part
> that MUST appear in every PRD body. The rest (Performance, Debugging, API reuse, TDD)
> guides authoring and interactive work.

## Performance

- State the time and space complexity of any non-trivial algorithm in a comment.
- Flag any nested loop over user-scaled data as a complexity hazard.
- Prefer O(n) solutions over O(n log n) only when n is provably small or constant.
- Lay out hot data contiguously and traverse it in memory order.
- Prefer arrays of structs or structs of arrays based on actual access patterns.
- Avoid pointer-chasing in inner loops on large datasets.

## Debugging approach

- State an explicit hypothesis before each debugging action.
- Describe what observation would confirm or refute the hypothesis.
- If three hypotheses fail, stop and re-examine your assumptions from scratch.
- When a bug was recently introduced, bisect commits to find the offender.
- When a bug is in a long pipeline, halve the input or code path until it localizes.
- Record each bisection step so the path to the root cause is reproducible.
- Never attempt a fix until you can reproduce the bug on demand.
- Capture the reproduction as a failing test before changing production code.
- If the bug cannot be reproduced, instrument the system until it can.

## API reuse and single source of truth

- One concept = one implementation. Before writing code that computes, fetches, formats, or displays a value, search the codebase for an existing implementation and reuse it. Do not write a second or third copy of the same logic.
- N display sites, ONE source. When the same datum appears in multiple places (a metric shown in several tabs, a value returned by several endpoints), it must flow from a single shared accessor / store / hook / endpoint. Displaying something in 3 places must not mean 3 implementations — it means 1 implementation with 3 call sites.
- Extend, don't fork. If an existing function/module/API is close but not sufficient, generalize it (add a param, widen the contract) rather than cloning a divergent variant. Prefer composition over duplication.
- Treat duplication as a latent bug. Copy-pasted logic drifts; divergence between copies is how silent inconsistencies ship (e.g. one site reads a 0–100 percentage as a 0–1 fraction). When you see the same logic in two places, consolidate it on sight and route both through the shared unit.
- Design for extensibility: stable shared contracts, single ownership, callers depend on the contract — not on a private copy. New surfaces consume the canonical API; they never reimplement it.
- When reviewing or implementing, explicitly check: "is this value/behaviour already produced elsewhere, and am I reusing that path?" If not, fix the reuse before adding the feature.

## Test-driven development

- Write the failing test first, then the implementation that makes it pass — for every feature and every bugfix.
- A bugfix starts with a test that reproduces the bug (red), then the fix (green).
- Do not write production code without a test asserting the behavior it adds.
- (Interactive sessions: the `test-driven-development` skill has the full red-green-refactor
  workflow. Headless PRD runs can't load it — the three rules above are the load-bearing core.)

## Visual design (UI/visual acceptance criteria)

When a PRD's acceptance criteria touch UI or visual output and no design brief is given,
resolve the visual direction in this priority order — never substitute a generic default when
a higher-priority source exists:

1. **User-supplied design.** If the PRD or the conversation that spawned it includes a design
   brief, mockup, brand palette, or explicit visual direction, use it verbatim.
2. **Existing project design system.** Before reaching for any external skill, check the repo
   itself for an existing theme — CSS custom-property blocks, `tailwind.config.js`, a
   design-tokens file, a component library already in use. Reuse and extend what's there
   rather than introducing a second visual language into the same project.
3. **Only if neither exists**, invoke a design-oriented skill rather than eyeballing colors
   from memory or hand-picking hex values (e.g. the bundled `dataviz` skill for
   chart/table/dashboard work, or a `frontend-design`-class skill for overall aesthetic
   direction) — and **render + screenshot both light and dark color-scheme modes** before
   calling the work done. A palette validator that checks categorical/series colors does not
   cover surrounding chrome tokens (panel/page/border) — those need their own contrast check
   (WCAG relative luminance) and a visual look in each mode. "I checked light mode" is not "I
   checked dark mode"; verify both, don't assume palette-reference hex values are safe by
   construction. (Incident: a dashboard shipped with panel/page background contrast of
   1.12:1 and a border at 1.34:1 in dark mode — both invisible — because only light mode was
   ever rendered before the work was marked done.)

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
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
