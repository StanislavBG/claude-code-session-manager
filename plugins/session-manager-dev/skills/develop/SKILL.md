---
name: develop
description: >-
  Lead a software-development task: analyze it from five angles, split it into small
  self-contained PRDs (an independent set, or a 3-5 PRD chain), queue them for the
  session-manager scheduler with the required gate and files, each pointing the headless
  executor at the engineering standards file, then track them to a validated finish and report
  back. Use whenever the user says "/develop", "develop X", "build me X", "implement X", "let's
  code X", or otherwise starts dev work that should run as scheduled PRDs rather than inline
  now. Home of the developer-only guidance (performance, debugging, API reuse, TDD). Keywords:
  develop, build, implement, code, feature, refactor, bugfix, queue dev work, PRDs, PRD chain,
  multi-angle analysis.
---

# /develop — plan, queue, track to done

Terms: **plan** = the PRDs one pass queues, ending in a validate PRD. **gate** = commands that
prove a PRD done. **files** = paths a PRD may change. **verdict line** = a run's last line
(`SCHEDULER_VERDICT: PASS`). **needs_review** = a parked PRD: a question for this Epic, never
new work. **report** = your final message to the human.

## Rules that always apply

1. **Epic gate. Run it first.**
   1. Your session id is `$SM_CHAT_SESSION_ID`.
   2. Read `session-manager-operations/prompt-sessions/active-index.json` in the main checkout
      (`$SM_PROJECT_ROOT`, or the first `git worktree list` path). Why: a worktree copy is
      frozen at branch time and often lacks this Epic.
   3. The `sessions` entry whose `claudeSessionId` matches is this Epic: its `id` is
      `<epic-id>`, its `tag` drives rule 2.
   4. No match: stop and say so. Tell the human to open an Epic with the New Epic card and run
      /develop there. Never mint an Epic or write a PRD without one. Why: only a human creates
      an Epic.
2. **Tag-aware default.** On a `feature`, `bug` or `art` Epic, PRDs are the expected path once scope
   is clear; start unasked. On a `discussion` Epic it stays available, but wait until the
   human settles that code is wanted.
3. **Never hand-implement in this session**, even when the plan is agreed. Why: this session
   runs an expensive planner model; a cheaper executor runs each PRD as a headless `claude -p`
   job.
4. **Never delegate PRD authoring.** You write scope, title, goal, criteria and notes. Calling
   `scheduler_create_prd` with your own text is not delegation.
5. **Never restate the engineering rules.** They live in `standards.md` beside this file, with
   the reasons behind the run rules. Interactive work uses the `test-driven-development`,
   `systematic-debugging` skills and the built-in `/code-review` for review. Why: one copy never goes stale.

## Phase 1 — plan and queue

Read `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` before writing PRDs.

### Plan objective

One goal = one validate PRD = one plan card on the Scheduler. Why: the Scheduler groups a plan
card as the validate PRD plus everything it transitively depends on.
The validate PRD's title is the card title, so write it as `Validate: <plain-language goal>`.
Keep one goal per validate PRD; a second goal is a second plan, with its own validate PRD.
Prefer wide over deep: PRDs that share no files run in parallel; only chain two PRDs on a real
file or output dependency, never to express reading order alone.
A follow-up or fix PRD for the same goal depends on that plan's open PRDs instead of starting
an unrelated root. Why: it keeps the fix inside the same card rather than minting a second,
unrelated one.

### Preflight — confirm the tool is even in your tool list

Before drafting, check that `mcp__session-manager-scheduler__scheduler_create_prd` is in your
tools. Why: drafts made first are wasted. It is the only sanctioned way to write a PRD. Its two
failure modes have different fixes:

- **(a) Tool PRESENT but ERRORS** because the session-manager app is not running. A validation
  error is not this case: fix the input and retry. **STOP. Do not write any PRD file.** Tell the
  human to start the app, then retry the same call. Why: a PRD file the API did not write is
  quarantined and never runs.
- **(c) Create errors with "did not answer" or "Connection closed".** It may still have been written; retry the same call with the same slug (it returns the existing PRD with `alreadyExisted: true`, or per entry `applied`) and never re-issue it under a new slug. `scheduler_get_prd` accepts the bare slug.
- **(b) Tool ABSENT from your tool list.** The `session-manager-scheduler` MCP server is not
  registered: a **misconfiguration**, not an offline app.
  **STOP. Do not write any PRD file.** Tell the human. The app registers the server at user
  scope the first time it starts. If it is still missing, the human deletes
  `~/.claude/session-manager/.scheduler-mcp-seeded`, restarts the app, and opens a new session.
  Never add a project `.mcp.json` entry yourself. Why: it brings back per-repo drift.

### Steps

1. **Clarify only what a wrong guess would cost rework on.** Ask 2–4 plain-text questions in
   one message, once, and wait. Never use AskUserQuestion. Why: Chat view turns run headless.
2. **Explore broadly.** Find the absolute path, helpers and patterns to reuse, the test
   command, constraints, and exact paths and signatures. Read look-alike siblings to confirm
   the shape. Check existing tests, and `scheduler_list_prds` for an open PRD on the same
   area. Why: a duplicate or contradicting PRD is a real failure.
3. **Use five lenses**, a sentence each, none skipped silently: positive path; edge cases
   (empty, max, concurrent, malformed, permission, failure); interaction effects (what depends
   on your change); integration (reuse the existing schema, store, API, primitives);
   validation (for UI: which screenshot, light and dark, proves which criterion).
4. **Run a completeness pass** if the ask exceeds one or two PRDs or spans subsystems: start it as a
   background sub-agent as soon as the draft list exists (Explore or general-purpose; the ask
   verbatim, your draft list, the lenses; ask what is missing) and keep exploring while it runs.
   The planner turn is hard-killed at 30 minutes with a warning at 24; late gaps become sibling
   PRDs. Fold in real gaps, drop vague ones. Repeat at most once. It reviews; you author.
5. **Tests and security go inside the feature's own PRD** as criteria (security when it
   touches input, auth or data), never as follow-ups. Why: TDD needs the test with the code;
   security is decided while writing it. Also check quality (performance, error handling).
   Deeper edge cases, hardening and docs may be sibling PRDs.
6. **Pick a shape.** Most asks are an independent set. Chain 3–5 PRDs only for truly
   sequential work: each link `dependsOn` the previous one; its notes name what that link
   delivers and say to read the landed code first. Never chain past 5; redo the completeness
   pass. Each goal's first sentence names its type, in chain order: `primitive` (new helper
   and its test), `wire` (adopt it at named call sites), `behavior` (one function's logic and
   its test), `migration` (mechanical change), `doc`, `validate`.
7. **Keep each PRD small**: at most 3 edited files, 1 new file, 6 criteria. Test files edited or added in lockstep with
   the PRD's own code do not count toward the 3-edited / 1-new file limit. The validate PRD is
   exempt: it has one criterion per PRD, plus the record. A new helper and its first caller are
   two PRDs. Most PRDs take 5–10 executor minutes; split anything expected
   to take over 15. Do not write an estimate. Why: the kill budget floors at 45 minutes, so a
   run without one is never starved.
8. **Make each PRD self-contained.** The executor sees only the PRD and the project. Notes are
   a recipe: `Read first:` (at most 4 files, with line ranges), `Steps:` (numbered, each naming
   file and function), `Do not touch:` (files a sibling owns). Quote signatures. Say when a PRD
   needs another PRD's output.
9. **Write plain, checkable criteria.** Each names a file, a symbol and the result; one names
   the test file and tests. Commands go in `gate`. No open-ended "grep X and update" lines.
10. **Show the plan once**: the plan goal line, the stage view (for example `Stage 1: A ∥ B →
    Stage 2: C → validate`), and a table (#, PRD, files, gate, dependsOn) — not PRD
    drafts. Queue at once when the Epic is `feature`, `bug` or `art` and scope is clear; otherwise ask
    one approval question, once.
11. Before queueing, run `git -C "$SM_PROJECT_ROOT" rev-parse HEAD` and keep the SHA.
    **Walk the pre-queue checklist** (last section of PRD_AUTHORING.md), then queue the whole
    plan, validate PRD included, in one `scheduler_create_prds` call; `dependsOn` may name other
    entries of that call. Use one `scheduler_create_prd` per PRD only if the batch tool is absent.
12. **Read the warnings each call returns before the next call.** Warnings do not block. If a
    gate or files warning shows a real mistake, fix it with `scheduler_update_prd`: its `gate`,
    `files` and `acceptanceCriteria` fields are validated and re-rendered. Why: a full body
    replacement is for prose only and is not re-checked. Never
    change a PRD only to silence a warning. The validate PRD's none-gate warning and its size
    warning (8 or more criteria) are expected. Then post one short message: each PRD's number and slug, the validate slug, the
    warnings you kept, and that no per-PRD check will come from this session.
13. **Never stop for review after queueing.** Why: the validator is the review.

### PRD fields

| Field | Rule |
| --- | --- |
| `title`, `goal`, `acceptanceCriteria`, `implementationNotes`, `outOfScope` | Steps 6–9. Goal: 2–4 sentences. |
| `gate`, `files` | **REQUIRED.** Rules below. The tool refuses a call without them. |
| `estimateMinutes` | Omit (a persona's `defaultEstimateMinutes` applies). Pass one only for a run needing more than the 45-minute floor. |
| `sourcePromptId` | Always `<epic-id>`. Never rely on the server's fallback. |
| `cwd` | The Epic's project root, as an absolute path or `~/…`. The API always uses the Epic's project, whatever you pass. To work in another project, open an Epic there. |
| `dependsOn` | Slugs that must finish first. The only ordering tool. |
| `disposition` | Only when the API asks. `append` waits behind the Epic's unfinished PRDs; `new-head` may run now, so only when no files are shared. |
| `slug` | Optional kebab-case without an `NN-` prefix. The API picks the number. |
| `tag`, `agentType` | Omit (`dev-lead` default), except on the validate PRD. |
| `quietMachine` | Only for timing measurements. |

Never pass `parallelGroup`; it is ignored. The API writes the frontmatter, the `# Files` and
`# Gate` sections and the standards pointer. Do not write them yourself. Do not put a gate
fence (three backticks + `gate`), a `# Gate` heading or a `# Files` heading in any text field —
the API rejects that.

### gate rules

1. 1–10 commands. The scheduler re-runs them, in order. Each must exit 0.
2. Start each `&&` step with `timeout <seconds>`, for example `timeout 300 npm test &&
   timeout 120 npm run lint`. Why: a command without a timeout can hang the run.
3. Join steps inside one entry with `&&`.
4. The scheduler runs gate commands without a shell, so shell syntax is refused. Outside single
   quotes, do not use `|` `<` `>` `;` `&` (only `&&` between steps), backticks, `$`, `\`, `*`,
   `?`, `[`, `]`, `(`, `)`, `{`, `}` or `!`. Inside double quotes, `$`, backticks and `\` are
   refused too.
5. Do not start a word with `#` or `~`, and do not put `~` right after `=` or `:`. `HEAD~1` is
   fine.
6. Put text with these characters inside single quotes, for example `rg -n 'a|b' src/`. A check
   that needs a shell belongs in a test file that the gate runs.
7. Keep each entry on one line, at most 500 chars, with plain spaces between words.
8. Use `["none"]` only for docs or config with no runnable check. Write exactly `none`. Never
   mix `none` with commands.
9. Put `NAME=value` words before `timeout`, never after it, for example
   `CI=1 timeout 300 npm test`. A leading `TMPDIR=$(mktemp -d) ` is allowed but not needed: the
   scheduler gives each gate its own TMPDIR.
10. Before queueing, run each gate command once at the current HEAD in the main checkout. If it
    is red, scope the gate to the PRD's own test files, never a suite that is already red, and
    say in the PRD notes which suite was red and why it was scoped out. Why: a gate that is red
    on the base parks the job as `sentinel_fail` whatever the executor does.
11. A gate command must not create or modify tracked files; write outputs to the per-gate TMPDIR
    or a gitignored path. Why: a dirtied tree fails the clean-tree check.
12. Never put a step only a human or the passage of time can complete (host cron install,
    waiting for a live post, a live payment, an account dashboard action) in a gate or
    criterion; keep them out of PRDs at authoring time. An executor that meets one ends
    `SCHEDULER_VERDICT: FAIL` naming what is missing. Why: no executor can pass such a gate,
    and queued work runs with no questions asked.
    Live-run steps that need gitignored state follow PRD_AUTHORING.md §7 (absolute main-checkout
    paths, artifact-only).

### files rules

1. 1–50 repo-relative paths. A folder ends with `/`.
2. No absolute paths, no `~` at the start, no `..` or `.` segments, no `*` or `?`, no `\` or
   backticks, no leading `-`. Use `/` between folders.
3. The scheduler never runs two PRDs with overlapping files at once (held as `files-overlap`);
   `dependsOn` is for real output or order dependencies only.

### What a headless run cannot do

The scheduler blocks ScheduleWakeup, Cron tools, Monitor, AskUserQuestion, plan mode, worktree
tools and background tasks. A `timeout` command is always on PATH (a shim on macOS). The run
never stops to ask; it makes the safest reasonable choice and reports it. So write PRDs that
need none of this and leave no decision open.

### How a PRD runs

The dev-lead persona runs orient (read `# Files`) → red (a failing test) → build → finish
protocol, which the scheduler appends: review → verify the `# Gate` commands → commit exact
paths → verdict line.

### The validate PRD

End every plan with exactly one validate PRD:

1. `agentType: "validator"`, `tag: "build"`, slug
   `validate-<short-plan-name>`. Its title is the plan goal shown on the Scheduler card, so
   write it as `Validate: <plain-language goal>`.
2. `dependsOn`: every other slug in the plan. Past the cap of 100, only the sinks (PRDs nothing
   depends on). Why: `dependsOn` is walked transitively.
3. Goal: the plan's slugs and titles.
4. Criteria: one per PRD, citing it by slug
   (under `$SM_PROJECT_ROOT/session-manager-operations/scheduler/epics/<epic-id>/`; find it by
   slug under prds/ or prds-archived/, possibly a timestamped subfolder. Why: `session-manager-operations/scheduler/` is gitignored, so it is never in
   the validator's job worktree. The last: write and commit
   `session-manager-operations/reviews/validation/<epic-id>/<validate-slug>.md`, relative to the repository root
   (`git rev-parse --show-toplevel`), not to any subdirectory you `cd`'d into to run a gate.
5. Notes: "Work as the validator persona — the procedure is your system prompt." and a line
   `Base: <sha>`, the SHA from step 11.
6. `gate: ["none"]`; `files`: the record path. Why: the validator re-runs each PRD's gate
   itself, and a REFUTED PRD is still a successful validation.

The validator prints `VALIDATION: <slug> VERIFIED` or `VALIDATION: <slug> REFUTED — <reason>`
per PRD. Queue the validate PRD in the same `scheduler_create_prds` call as the plan (its `dependsOn` may name that call's entries); with single creates it goes last: in a single `scheduler_create_prd`, `dependsOn` accepts only slugs that already exist. The
scheduler sends no per-PRD validation prompt. When the Epic has no pending or running PRD for
`SM_EPIC_SETTLE_SECONDS` (default 120), it queues one `validate-sweep-*` validator for completed
PRDs no validator checked, then sends one PLAN SETTLED digest. Several validators in one Epic
are fine: each runs headless.

If the API rejects `agentType: "validator"`, the persona is not installed: keep the plan
queued, say so, ask the human to restart the app, and validate the digest's Not validated list
here. Never write the record yourself.

## Phase 2 — track to done

The scheduler heals most parks itself:

1. Verdict-line parks (verdicts no_verdict_sentinel,
   abandoned_background_task) complete when the gate re-run is green, the landed commit is on
   HEAD and the tracked tree is clean.
2. Stray-checkout parks (the main checkout was on another branch) are re-landed onto the base
   branch ref without touching the checkout.
3. needs_review notices are held and grouped per Epic and cause. One notice is sent only when
   the ladder gives up or the hold time ends (default 4 hours, `SM_REVIEW_NOTICE_HOLD_MINUTES`).

Rules:

1. Do not poll, re-verify each PRD, or arm ScheduleWakeup or a loop. Finished PRDs arrive as
   check-in events; leave them alone.
2. Do not re-queue or reset on a single park or a rate-limit pause. Why: the scheduler may
   still heal it; a duplicate races the healed run.
3. Act only on these signals:
   1. **A grouped scheduler notice** (needs_review). Read each file on its `Reports:` line. For
      each PRD on its `PRDs:` line, take the first case that fits:
      1. It is skipped and the plan's validate PRD has not run yet: do nothing. The validator
         reports it, and the fix wave covers it.
      2. Its spec is wrong: fix it with `scheduler_update_prd`, then call `scheduler_reset_job`
         (add `force: true` if it is skipped). Always edit first. Why: a reset job can start on
         the next tick. Fix `gate`, `files` and `acceptanceCriteria` through their validated,
         re-rendered fields; use a full body replacement only for prose.
      3. Its spec is right: call `scheduler_reset_job` (add `force: true` if it is skipped).
      4. Another PRD or a human already did the work: confirm it in the tree, then call
         `scheduler_archive_prd`. Archiving marks it completed and frees the PRDs that depend on
         it.
      A parked validator arrives this way too.
      Never relay a question to the human: resolve every PRD through cases 1-4, making the
      safest reasonable choice, and report it. Why: queued work runs with no questions asked.
   2. **A PLAN SETTLED digest.** Read the validator records it names. A `REFUTED` PRD, or a
      Critical or Important finding, means a fix wave: one `behavior` or `wire` PRD per finding
      plus a new validate PRD. Never fix inline. A Not validated list means validate exactly
      those PRDs here. All `VERIFIED` with nothing open means Done: write the final report.
4. **Done** = the latest validator marked every PRD `VERIFIED`, no Critical or Important
   finding is open, and its record is committed. Never "done with caveats": a REFUTED PRD gets
   a fix wave or an explicit human decision to stop.

### Final report

1. What landed: each PRD slug and its commit.
2. The validation record path.
3. Minor findings deferred.
4. Anything still open.
5. Any warning kept or validator skipped.

## Never

- Write a PRD by hand, or anywhere the API does not. `data/prds/`, `docs/prds/`,
  `~/.claude/session-manager/scheduled-plans/prds/` and the retired flat
  `session-manager-operations/scheduler/prds/` never run.
- Combine unrelated features in one PRD.
