---
name: develop
description: >-
  Lead a software-development task inside a Session Manager Epic: analyze it, split it into
  small self-contained PRDs (an independent set, or a 3-5 PRD chain), queue them for the
  session-manager scheduler, then track them to a validated finish and report back. Use when
  the user says "/develop" or asks for code to be built, fixed or refactored as scheduled PRDs
  rather than inline — features, bug fixes, refactors, follow-up fix waves.
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
      `<epic-id>`, its `tag` and `developLoop` drive rule 2.
   4. No match: stop and say so. Tell the human to open an Epic with the New Epic card and run
      /develop there. Never mint an Epic or write a PRD without one. Why: only a human creates
      an Epic.
2. **Tag-aware default.** On a `feature`, `bug` or `art` Epic, PRDs are the expected path once scope
   is clear; start unasked. On a `discussion` Epic it stays available, but wait until the
   human settles that code is wanted. An Epic with no tag (No mission) is treated like `discussion`.
   If `developLoop` is `false`, do not author PRDs (the API refuses them): tell the human this
   session was started without the develop loop and a new session with it on is needed to queue work. Stop.
3. **Never hand-implement a PRD's work in this session**, even when the plan is agreed. Work
   small enough to do inline (the Actor persona's lane rule) never becomes a PRD. Why: this
   session runs an expensive planner model; a cheaper executor runs each PRD headless.
4. **Never delegate PRD authoring.** You write scope, title, goal, criteria and notes. Calling
   `scheduler_create_prd` with your own text is not delegation.
5. **Never restate the engineering rules.** They live in `standards.md` beside this file, with
   the reasons behind the run rules. Interactive work uses the built-in `/code-review` for
   review (and `test-driven-development` / `systematic-debugging` skills when installed). Why:
   one copy never goes stale.
6. **No residue.** A report hands back nothing an agent could do. Give every follow-up, gap,
   finding (any severity) and open choice one outcome in the same turn: **queued** (its PRD
   slug), **decided** (what you chose and a one-line revert), **scheduled** (what fires it
   later: a `dependsOn`, a `preflight` hold or a date) or **closed** (a one-line reason). Only
   a step that needs the human's own hands or authority goes under Needs you, as one exact
   action: sudo, a vendor agreement, a 2FA code, a public publish nobody approved, or a switch
   the project laws reserve for a human, or a PRD refuted twice on the same criterion (one
   decision: re-plan it or drop that criterion). Never write "deferred", "follow-up for later", "needs
   a new Epic from you" or "say the word". Why: a list nobody owns becomes debt the human has
   to chase. Enforced by the plugin's Stop hook (`hooks/residue-check.cjs`): it checks each
   Epic chat turn once and asks for an outcome for any line that hands work back;
   `SM_RESIDUE_CHECK=0` turns it off.

## Phase 1 — plan and queue

Read `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` before writing PRDs.

### Plan objective

One goal = one validate PRD = one plan card on the Scheduler. Why: the Scheduler groups a plan
card as the validate PRD plus everything it transitively depends on.
The validate PRD's title is the card title, so write it as `Validate: <plain-language goal>`.
Keep one goal per validate PRD; a second goal is a second plan, with its own validate PRD.
A defect you find in this project outside the Epic's goal is such a second plan, queued in this
Epic (a side plan with its own `Validate: <goal>` PRD); the Epic's title and objective stay
unchanged. Never hand it back as needing a new Epic. A defect in another project goes to
`/send-feedback`.
Prefer wide over deep: PRDs that share no files run in parallel; only chain two PRDs on a real
file or output dependency, never to express reading order alone.
A follow-up or fix PRD for the same goal depends on that plan's open PRDs instead of starting
an unrelated root. Why: it keeps the fix inside the same card rather than minting a second,
unrelated one.

### Preflight — confirm the tool is even in your tool list

Before drafting, check that `mcp__session-manager-scheduler__scheduler_create_prd` is in your
tools. Why: drafts made first are wasted. It is the only sanctioned way to write a PRD. Its
three failure modes have different fixes:

- **(a) Tool PRESENT but ERRORS** because the session-manager app is not running. A validation
  error is not this case: fix the input and retry. **STOP. Do not write any PRD file.** Tell the
  human to start the app, then retry the same call. Why: a PRD file the API did not write is
  quarantined and never runs.
- **(b) Create errors with "did not answer" or "Connection closed".** It may still have been written; retry the same call with the same slug (it returns the existing PRD with `alreadyExisted: true`, or per entry `applied`) and never re-issue it under a new slug. `scheduler_get_prd` accepts the bare slug.
- **(c) Tool ABSENT from your tool list.** The `session-manager-scheduler` MCP server is not
  registered: a **misconfiguration**, not an offline app.
  **STOP. Do not write any PRD file.** Tell the human. The app registers the server at user
  scope the first time it starts. If it is still missing, the human deletes
  `~/.claude/session-manager/.scheduler-mcp-seeded`, restarts the app, and opens a new session.
  Never add a project `.mcp.json` entry yourself. Why: it brings back per-repo drift.

### Steps

1. **Clarify only what a wrong guess would cost rework on.** Ask 2–4 plain-text questions in
   one message, once, and wait. Never use AskUserQuestion. Why: Chat view turns run headless.
   Decide instead of asking when the human's own words, the project laws or memory, or the code
   already settle the choice, or when git can revert a wrong guess; report it under Decided
   (rule 6). Ask only about what is irreversible outside git (data loss, a public publish,
   money, contacting people) or what the project laws reserve for the human. Never repeat an
   unanswered question in a later turn: take the option you recommended, unless the choice is
   reserved.
2. **Explore broadly.** Find the absolute path, helpers and patterns to reuse, the test
   command, constraints, and exact paths and signatures. Read look-alike siblings to confirm
   the shape. Check existing tests, and `scheduler_list_prds` for an open PRD on the same
   area. Why: a duplicate or contradicting PRD is a real failure.
3. **Use five lenses**, a sentence each, none skipped silently: positive path; edge cases
   (empty, max, concurrent, malformed, permission, failure); interaction effects (what depends
   on your change); integration (reuse the existing schema, store, API, primitives);
   validation (for UI: which screenshot, light and dark, proves which criterion).
4. **Plans of 3+ PRDs, or any chain, are held for an independent plan review before dispatch**
   (`held: plan-review`). `SM_PLAN_REVIEW=0` is off;
   `SM_PLAN_REVIEW_HOLD_MINUTES` is the timeout.
5. **Tests and security go inside the feature's own PRD** as criteria (security when it
   touches input, auth or data), never as follow-ups. Why: TDD needs the test with the code;
   security is decided while writing it. Also check quality (performance, error handling).
   Deeper edge cases, hardening and docs may be sibling PRDs.
   When the project has a Field Manual (`session-manager-operations/manual/manual.json`
   exists), a plan that ships or changes a user-visible surface includes one sibling `doc`
   PRD that writes or revises its chapter under `session-manager-operations/manual/chapters/`,
   in the same plan and covered by the plan's `validate` PRD. Skip it when the project has no
   `manual.json`. Why: a release never finds a gap it can only report.
6. **Pick a shape.** Most asks are an independent set. Chain 3–5 PRDs only for truly
   sequential work: each link `dependsOn` the previous one; its notes name what that link
   delivers and say to read the landed code first. Never chain past 5; re-split the plan.
   Each goal's first sentence names its type, in chain order: `primitive` (new helper
   and its test), `wire` (adopt it at named call sites), `behavior` (one function's logic and
   its test), `migration` (mechanical change), `doc`, `validate`. A gap you leave out of the
   first plan is queued in the same turn as a later wave that `dependsOn` the PRDs it builds
   on, or held by `preflight` or a date when it must wait for something. Never list it as "not
   covered" or "stage 2".
7. **Keep each PRD small**: at most 3 edited files, 1 new file, 6 criteria. Test files edited or added in lockstep with
   the PRD's own code do not count toward the 3-edited / 1-new file limit. The validate PRD is
   exempt: it has one criterion per PRD, plus the record. A new helper and its first caller are
   two PRDs. Most PRDs take 5–10 executor minutes; split anything expected
   to take over 15. Do not write an estimate. Why: the kill budget floors at 45 minutes, so a
   run without one is never starved. A validator's budget is sized from the gates it must
   re-run, so the validate PRD omits it too.
8. **Make each PRD self-contained.** The executor sees only the PRD and the project. Notes are
   a recipe: `Read first:` (at most 4 files, with line ranges), `Steps:` (numbered, each naming
   file and function), `Do not touch:` (files a sibling owns). Quote signatures. Say when a PRD
   needs another PRD's output.
9. **Write plain, checkable criteria.** Each names a file, a symbol and the result; one names
   the test file and tests. Commands go in `gate`. No open-ended "grep X and update" lines.
   A check against a running local service is an `http` criterion `{ kind: 'http', spec: { url, status?, contains? } }` (loopback only), run by the scheduler outside the sandbox,
   because a job's Bash cannot reach host loopback; the URL host is 127.0.0.1 or localhost, whichever the server listens on ([::1] only for an IPv6 listener), never the machine hostname, which criteria refuse.
   Write a structural expectation (for example every item has a non-empty field) in the criterion statement; the validator judges it from the stored response body.
   What http cannot express (auth, POST, UI) the architect checks at PLAN SETTLED from the Epic.
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
    change a PRD only to silence a warning. Then post one short message: each PRD's number and
    slug, the validate slug, and that no per-PRD check will come from this session. Name a
    warning only if you changed a PRD because of it.
13. **Never stop for review after queueing.** Why: the plan reviewer reviews before dispatch and the validator after.

### PRD fields

| Field | Rule |
| --- | --- |
| `title`, `goal`, `acceptanceCriteria`, `implementationNotes`, `outOfScope` | Steps 6–9. Goal: 2–4 sentences. |
| `gate`, `files` | **REQUIRED.** Rules below. The tool refuses a call without them. |
| `estimateMinutes` | Omit (a persona's `defaultEstimateMinutes` applies). Pass one only for a run needing more than the 45-minute floor. |
| `sourcePromptId` | Always `<epic-id>`. Never rely on the server's fallback. |
| `cwd` | The Epic's project root; see PRD_AUTHORING.md §5. |
| `dependsOn` | Slugs that must finish first. The only ordering tool. |
| `disposition` | Only when the API asks. `append` waits behind the Epic's unfinished PRDs; `new-head` may run now, so only when no files are shared. |
| `slug` | Optional kebab-case without an `NN-` prefix. The API picks the number. |
| `tag`, `agentType` | Omit (`dev-lead` default), except on the validate PRD. |
| `quietMachine` | Only for timing measurements. |

Never pass `parallelGroup`; it is ignored. The API writes the frontmatter, `# Files` and
`# Gate` (PRD_AUTHORING.md §6, What the API writes).

### gate and files rules

The syntax rules for `gate` and `files` are in PRD_AUTHORING.md §6, and the API enforces them: it
refuses a bad gate or path and returns warnings — read them and fix the input. Three rules only you
can apply, because they depend on the repo at authoring time:

1. Before queueing, run each gate command once at the current HEAD in the main checkout. If it
   is red, scope the gate to the PRD's own test files, never a suite that is already red, and
   say in the PRD notes which suite was red and why it was scoped out. Why: a gate that is red
   on the base parks the job as `sentinel_fail` whatever the executor does.
2. Never put a step only a human or the passage of time can complete (host cron install,
   waiting for a live post, a live payment, an account dashboard action) in a gate or
   criterion; keep them out of PRDs at authoring time (PRD_AUTHORING.md §14, No human-only gates).
   Live-run steps that need gitignored state follow PRD_AUTHORING.md §7 (absolute main-checkout
   paths, artifact-only).
3. Never list a path under `.claude/agents`, `commands`, `skills`, `hooks` or `settings*.json` in
   `files`: the job sandbox refuses every write there, so the architect makes that edit inline
   in the Epic chat (PRD_AUTHORING.md#job-sandbox-limits).

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
   slug under prds/ or prds-archived/, possibly a timestamped subfolder. Why: runtime namespaces such as `session-manager-operations/scheduler/` carry their own `.gitignore`
   (runtime-ops-namespaces-self-ignore), so they are never in the validator's job worktree. The last: write
   `session-manager-operations/plan-records/<epic-id>/<validate-slug>.md`, relative to the repository root
   (`git rev-parse --show-toplevel`), not to any subdirectory you `cd`'d into to run a gate. Never
   commit it; the scheduler copies it to the main checkout.
5. Notes: "Work as the validator persona — the procedure is your system prompt." and a line
   `Base: <sha>`, the SHA from step 11.
6. `gate: ["none"]`; `files`: the record path
   `session-manager-operations/plan-records/<epic-id>/<validate-slug>.md`. It is never committed:
   the API declares the PRD artifact-only. Why: the validator re-runs each PRD's gate
   itself, and a REFUTED PRD is still a successful validation.

A per-run record from any other PRD (ship, deploy, audit) also goes under
`session-manager-operations/plan-records/<epic-id>/`; never name a git-ignored ops path in `files` to get it force-added.

The validator returns a checked JSON verdict (`VERIFIED` or `REFUTED` with a reason, per PRD). The
scheduler saves it as `session-manager-operations/plan-records/<epic-id>/<validate-slug>.verdicts.json`, and
`GET /admin/epic` serves it as `verdicts`. Queue the validate PRD in the same `scheduler_create_prds` call as the plan (its `dependsOn` may name that call's entries); with single creates it goes last: in a single `scheduler_create_prd`, `dependsOn` accepts only slugs that already exist. The
scheduler sends no per-PRD validation prompt. When the Epic has no pending or running PRD for
`SM_EPIC_SETTLE_SECONDS` (default 120), it queues one `validate-sweep-*` validator for completed
PRDs no validator checked (a large sweep becomes several sweeps in turn), then sends one PLAN SETTLED digest. PRDs held on a precondition, and validators waiting only on them, do not hold back the digest, which lists them. Several validators in one Epic
are fine: each runs headless.

If the API rejects `agentType: "validator"`, the persona is not installed: keep the plan
queued, say so, ask the human to restart the app, and validate the digest's Not validated list
here. Never write the record yourself.

## Phase 2 — track to done

The scheduler heals most parks itself:

1. Verdict-line parks (verdicts no_verdict_sentinel,
   abandoned_background_task) complete on their own once the conditions in PRD_AUTHORING.md
   §13 hold.
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
      finding at any severity (Critical, Important or Minor), means a fix wave: one `behavior`
      or `wire` PRD per finding plus a new validate PRD. A finding with nothing to fix gets a
      one-line close reason in the report instead. Never fix inline. Every fix PRD sets `fixes: [{ prd, missKind, reason }]`,
      one entry per PRD it repairs, including a PRD a validator `VERIFIED` whose bug was found later
      (an escape). Why: escapes are counted from `fixes`. The new validate PRD has one criterion per fix
      PRD and one per PRD the earlier validator marked `REFUTED`, each cited by slug. Why: a
      refuted PRD keeps its Epic blocked until a validator verifies that same PRD. A PRD marked
      `REFUTED` again after its fix wave, on the same criterion, gets no third fix wave: put it
      under Needs you (rule 6) with the validator's reason and what was tried. Why: a second miss on the same criterion means the plan is wrong, and another
      wave would repeat it. A Not validated list means validate exactly those PRDs here. All
      `VERIFIED` with nothing open means Done: write the final report.
   3. **A PLAN REVIEWED digest.** Apply amendments via `scheduler_update_prd`, give a one-line
      reason per rejected finding, then release with one `scheduler_release_plan` call
      (`rereview` only after a block, once).
   4. **A `PRECONDITION HOLD` notice** is not a park and not a fix-wave trigger. Do nothing — no
      reset, no edit, no fix PRD; the scheduler re-checks the preflight on its own. State the
      missing precondition in the report. Why: only a person can supply it.
4. **Done** = the latest validator marked every PRD `VERIFIED`, including each PRD an earlier
   validator refuted, every finding at every severity is fixed or closed with a reason, and its record exists in the main checkout's
   `session-manager-operations/plan-records/<epic-id>/`.
   Never "done with caveats": a REFUTED PRD gets a fix wave, or after its second refutation a
   Needs you entry for the human to decide.

### Final report

1. **Landed:** each PRD slug and its commit; the validation record path (it exists in the main
   checkout's `session-manager-operations/plan-records/<epic-id>/`).
2. **Decided:** each choice you made instead of asking, with a one-line revert.
3. **Queued:** side plans and later waves still to run, by slug. They finish without the human.
4. **Scheduled:** what fires on its own later, and its trigger. A reply owed to another project after a release is a
   `feedback_reply` with `release.commits` (the work's commits) whose message writes `{version}`; never hand-type a version.
   On an app newer than 0.142.0, send it at once with `deliverWhen.appVersionAbove` = `admin-api.json` `appVersion`:
   it sends itself once a release whose tag contains the commits runs, even if this Epic is closed. On 0.142.0 or older,
   queue a held release check PRD and send the reply live, with `release.commits`, at its PLAN SETTLED.
5. **Needs you:** only steps rule 6 allows, including a PRD refuted twice, one exact action each. Omit it when empty.

Expected API warnings and skipped optional steps are not reported.

## Never

- Write a PRD by hand, or anywhere the API does not. data/prds/, docs/prds/,
  `~/.claude/session-manager/scheduled-plans/prds/` and the retired flat
  `session-manager-operations/scheduler/prds/` never run.
- Combine unrelated features in one PRD.
