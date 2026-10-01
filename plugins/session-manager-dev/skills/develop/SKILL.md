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
2. **Tag-aware default.** On a `feature` or `bug` Epic, PRDs are the expected path once scope
   is clear; start unasked. On a `discussion` Epic it stays available, but wait until the
   human settles that code is wanted.
3. **Never hand-implement in this session**, even when the plan is agreed. Why: this session
   runs an expensive planner model; a cheaper executor runs each PRD as a headless `claude -p`
   job.
4. **Never delegate PRD authoring.** You write scope, title, goal, criteria and notes. Calling
   `scheduler_create_prd` with your own text is not delegation.
5. **Never restate the engineering rules.** They live in `standards.md` beside this file, with
   the reasons behind the run rules. Interactive work uses the `test-driven-development`,
   `systematic-debugging` and `requesting-code-review` skills. Why: one copy never goes stale.

## Phase 1 — plan and queue

Read `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` before writing PRDs.

### Preflight — confirm the tool is even in your tool list

Before drafting, check that `mcp__session-manager-scheduler__scheduler_create_prd` is in your
tools. Why: drafts made first are wasted. It is the only sanctioned way to write a PRD. Its two
failure modes have opposite answers:

- **(a) Tool PRESENT but ERRORS** because the session-manager app is not running. A validation
  error is not this case: fix the input and retry.
- **(b) Tool ABSENT from your tool list.** The `session-manager-scheduler` MCP server is not
  registered: a **misconfiguration**, not an offline app.
  **STOP. Do not write any PRD file.** Tell the human. The app registers the server at user
  scope when it starts; if it is still missing, the human runs
  `claude mcp add session-manager-scheduler --scope user -- node "$SM_ROOT/scripts/scheduler-mcp-server.cjs"`
  (`$SM_ROOT` = the installed package root, four folders above this skill's folder) and opens
  a new session. Never add a project `.mcp.json` entry yourself. Why: it brings back per-repo
  drift.

**Fallback for case (a) only.** Hand-write the file as the "Fallback: writing the PRD file
directly" section of PRD_AUTHORING.md says, ending with the `## Engineering standards` pointer
the API writes (`standards.md`'s absolute path). Your report must say visibly: the app was not
running, you hand-wrote the file, its exact path, and that a human must check it. Why: the
API's checks did not run.

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
4. **Run a completeness pass** if the ask exceeds one or two PRDs or spans subsystems: give one
   Explore or general-purpose sub-agent the ask verbatim, your draft list and the lenses; ask
   what is missing. Fold in real gaps, drop vague ones. Repeat at most once. It reviews; you
   author.
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
7. **Keep each PRD small**: at most 3 edited files, 1 new file, 6 criteria. A new helper and its
   first caller are two PRDs. Most PRDs take 5–10 executor minutes; past estimates were 3–5×
   too high. Never estimate over 15; split. Why: the kill budget floors at 45 minutes, so a low
   estimate never starves a run.
8. **Make each PRD self-contained.** The executor sees only the PRD and the project. Notes are
   a recipe: `Read first:` (at most 4 files, with line ranges), `Steps:` (numbered, each naming
   file and function), `Do not touch:` (files a sibling owns). Quote signatures. Say when a PRD
   needs another PRD's output.
9. **Write plain, checkable criteria.** Each names a file, a symbol and the result; one names
   the test file and tests. Commands go in `gate`. No open-ended "grep X and update" lines.
10. **Show the plan once**, as a table (#, PRD, files, gate, dependsOn, estimate), not PRD
    drafts. Queue at once when the Epic is `feature` or `bug` and scope is clear; otherwise ask
    one approval question, once.
11. **Walk the pre-queue checklist** (last section of PRD_AUTHORING.md), then queue each PRD
    with `scheduler_create_prd`, the validate PRD last.
12. **Fix each warning** the API returns with `scheduler_update_prd`, or say why you keep it.
    Then post one short message: each PRD's number and slug, the validate slug, and that no
    per-PRD check will come from this session.
13. **Never stop for review after queueing.** Why: the validator is the review.

### PRD fields

| Field | Rule |
| --- | --- |
| `title`, `goal`, `acceptanceCriteria`, `implementationNotes`, `outOfScope` | Steps 6–9. Goal: 2–4 sentences. |
| `gate`, `files` | **REQUIRED.** Rules below. The tool refuses a call without them. |
| `estimateMinutes` | Honest: 5–10, never over 15. |
| `sourcePromptId` | Always `<epic-id>`. Never rely on the server's fallback. |
| `cwd` | Always the project's absolute path (`$SM_PROJECT_ROOT`). |
| `dependsOn` | Slugs that must finish first. The only ordering tool. |
| `disposition` | Only when the API asks. `append` waits behind the Epic's unfinished PRDs; `new-head` may run now, so only when no files are shared. |
| `slug` | Optional kebab-case without an `NN-` prefix. The API picks the number. |
| `tag`, `agentType` | Omit (`dev-lead` default), except on the validate PRD. |
| `quietMachine` | Only for timing measurements. |

Never pass `parallelGroup`; it is ignored. The API writes the frontmatter, the `# Files` and
`# Gate` sections and the standards pointer. Do not write them yourself, and do not put a gate
fence (three backticks + `gate`) in the goal, notes or criteria — the API rejects that.

### gate rules

1. 1–10 commands. The scheduler re-runs them, in order. Each must exit 0.
2. Start each command with `timeout <seconds>`. Why: a command without a timeout can hang the
   run.
3. Join steps inside one entry with `&&`.
4. No pipes, redirects, `;`, `&`, backticks, `$(` or `${`. Why: the scheduler runs gate
   commands without a shell.
5. Do not start an entry with `#`. Keep each entry on one line, at most 500 chars.
6. Use `["none"]` only for docs or config with no runnable check. Never mix `none` with
   commands.
7. A leading `TMPDIR=$(mktemp -d) ` and `NAME=value` words are allowed before the command.

A check that needs a shell belongs in a test file that the gate runs.

### files rules

1. 1–50 repo-relative paths. A folder ends with `/`.
2. No absolute paths, no `~`, no `..`, no `*` or `?`.
3. PRDs that can run at the same time must not share a file. If two PRDs touch the same file,
   chain them with `dependsOn`.

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

1. `agentType: "validator"`, `tag: "build"`, `estimateMinutes: 10`, slug
   `validate-<short-plan-name>`.
2. `dependsOn`: every other slug in the plan. Past the cap of 100, only the sinks (PRDs nothing
   depends on). Why: `dependsOn` is walked transitively.
3. Goal: the plan's slugs and titles.
4. Criteria: one per PRD, naming its file
   (`session-manager-operations/scheduler/epics/<epic-id>/prds/<NN>-<slug>.md` while queued,
   `prds-archived/` beside it once done; find it by slug). The last: write and commit
   `session-manager-operations/reviews/validation/<epic-id>/<validate-slug>.md`.
5. Notes: "Work as the validator persona — the procedure is your system prompt."
6. `gate: ["none"]`; `files`: the record path. Why: the validator re-runs each PRD's gate
   itself, and a REFUTED PRD is still a successful validation.

The validator prints `VALIDATION: <slug> VERIFIED` or `VALIDATION: <slug> REFUTED — <reason>`
per PRD. While it is pending, the scheduler skips per-PRD validation prompts and in-run review.

If the API rejects `agentType: "validator"`, the persona is not installed: keep the plan
queued, say so, ask the human to restart the app, and answer each VALIDATION REQUEST the
scheduler sends here. Never write the record yourself.

## Phase 2 — track to done

The scheduler heals most parks itself:

1. Transcript-noise parks (verdicts transcript_errors, no_verdict_sentinel,
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
3. Act only on two signals:
   1. **A grouped scheduler notice** (needs_review). Read each file on its `Reports:` line. Fix
      each PRD on its `PRDs:` line (`scheduler_update_prd`, then `scheduler_reset_job`) or drop
      it (`scheduler_archive_prd`). A parked validator arrives this way too.
   2. **A validator verdict.** Read its record. A `REFUTED` PRD, or a Critical or Important
      finding, means a fix wave: one `behavior` or `wire` PRD per finding plus a new validate
      PRD. Never fix inline.
4. **Done** = the latest validator marked every PRD `VERIFIED`, no Critical or Important
   finding is open, and its record is committed. Never "done with caveats": a REFUTED PRD gets
   a fix wave or an explicit human decision to stop.

### Final report

1. What landed: each PRD slug and its commit.
2. The validation record path.
3. Minor findings deferred.
4. Anything still open.
5. Any fallback used, warning kept or validator skipped.

## Never

- Write a PRD anywhere the API does not. `data/prds/`, `docs/prds/`,
  `~/.claude/session-manager/scheduled-plans/prds/` and the retired flat
  `session-manager-operations/scheduler/prds/` never run.
- Combine unrelated features in one PRD.
