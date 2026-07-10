---
name: develop
description: >-
  Lead a software-development task by decomposing a feature/refactor/bugfix prompt into a
  series of self-contained PRDs queued for the session-manager scheduler, each carrying the
  engineering standards inline so the headless executor honors them — then track those PRDs
  to completion, verify them against their acceptance criteria, and report back. Use whenever
  the user says "/develop", "develop X", "build me X", "implement X", "let's code X", or
  otherwise starts dev work that should run as scheduled PRDs rather than inline now. This
  skill is the home for the developer-only guidance (performance, debugging, API-reuse, TDD)
  that was removed from the always-on global CLAUDE.md. Keywords: develop, build, implement,
  code, feature, refactor, bugfix, queue dev work, PRDs.
---

# /develop — prompt → scheduled PRDs → tracked to done

**Role:** `/develop` owns the *pipeline*: it turns a development request into one or more
self-contained PRDs, queues them, and tracks them to completion. It is the convergence point
for both entry paths — an interactive human prompt comes straight here; an agent feedback file
arrives via `/process-feedback`, which evaluates it and then calls this skill. Everything from
here on is identical regardless of who asked.

**Never** hand-implement the work inline in chat, and never restate rules that live elsewhere:
the engineering rules belong to `standards.md`. Reference it; don't fork it.

This applies even when the plan is already fully scoped and confirmed in conversation — that
makes the PRD queue clean, it isn't a reason to skip queuing. The reason to route through the
scheduler isn't decomposition need, it's model economics: keep the interactive main-loop session
(an expensive planner-tier model) focused on discussion and decisions, and let a cheaper executor
model do the implementing as a headless `claude -p` job.

**Only execution is delegated — authoring never is.** Write every PRD's markdown yourself, in
the main loop: the thinking, decomposition, scope, and acceptance criteria are the planner's
job. Do not spawn a subagent to draft a PRD or otherwise hand off the writing/thinking — that
defeats the point of keeping planning on the expensive model. The scheduled `claude -p` job is
the only step that runs on the cheaper executor.

## Standards (single source of truth)

The engineering standards (Performance, Debugging, API reuse / single source of truth, TDD,
and the executor-facing Execution discipline) live in **`standards.md`** beside this file:
`~/.claude/skills/develop/standards.md`. Read it, hold it while planning, and inline it
verbatim into every PRD you emit (Phase 1 step 4). Never restate or fork its content — one
concept, one implementation.

For interactive dev work, also apply the `test-driven-development` and `systematic-debugging`
skills; the headless PRDs get the distilled core from `standards.md` instead, since they
can't load skills.

## Phase 1 — Author + queue the PRDs

1. **Clarify scope first.** If the prompt has genuine ambiguity (acceptance criteria, target
   repo, framework, edge cases), ask 2–4 focused questions as plain text and wait. Don't use
   the AskUserQuestion tool. Don't guess on decisions that would cost real rework. (When the
   caller is `/process-feedback`, scope is already established by its evaluation — don't
   re-ask; build from the brief it hands you.)

2. **Explore the target repo.** Identify the absolute `cwd`, existing patterns/utilities to
   reuse (per the API-reuse standard — search before writing new code), the test command, and
   any constraints. Capture exact file paths and signatures; they go straight into the PRDs.

3. **Decompose into a series of SMALL, bounded PRDs.** Split a large ask into multiple PRDs and
   sequence them. To pick each PRD's `NN` (parallel group), **compute the highest in-use number
   deterministically — never eyeball or narrow-grep the `ls`** (a narrowed pattern like
   `'^10[0-9]'` silently misses `110+` and collides):
   ```bash
   ls ~/.claude/session-manager/scheduled-plans/prds/ | grep -oE '^[0-9]+' | sort -n | uniq | tail -5
   ```
   The last line is the current max. Then: same `NN` as a logically independent sibling that
   can run in parallel; **next free `NN` = max+1** when this PRD hard-depends on prior work or
   is unrelated to every existing group. Record each cross-PRD dependency in the dependent
   PRD's notes.

   ### PRD structure and location

   Each individual PRD must follow this structure — this is `/develop`'s single authority on
   one PRD's structure, location, and scope sizing (the engineering rules stay separate, in
   `standards.md`).

   You are writing a PRD that will be executed by the user's session-manager scheduler — a
   system that runs `claude -p <prd-body> --dangerously-skip-permissions` jobs around 5-hour
   token-window resets, with auto-pause on rate-limit and auto-resume.

   **Canonical location — non-negotiable.** PRDs MUST be written to:
   ```
   ~/.claude/session-manager/scheduled-plans/prds/<NN>-<kebab-slug>.md
   ```
   **Anywhere else doesn't get scheduled.** If you write to `data/prds/`, `docs/prds/`, or the
   project root, the scheduler will not see it and the user loses their token-budget-managed
   execution. There is exactly one queue for all projects — that's intentional, because the
   5-hour token budget is global across all of the user's Claude work. The `~` expands to
   `os.homedir()` so the same convention works for any user on any machine.

   **Filename rules.** `NN` is the 2-digit zero-padded parallel group (picked per the `ls`
   command above — same `NN` as an independent sibling, or next free `NN` = max+1 when this PRD
   hard-depends on prior work). `<kebab-slug>` is a short, descriptive kebab-case identifier
   (e.g. `voice-commands-send-cancel`, `ticker-velocity-mcp`), kept under 60 chars. Verify your
   chosen filename doesn't already exist before writing.

   **Required frontmatter:**
   ```yaml
   ---
   title: <one-line human-readable title>
   cwd: <path to target project — where claude -p will run>
   estimateMinutes: <integer wall-clock estimate>
   ---
   ```
   `cwd` is critical — without it the job runs in the scheduler's default cwd (session-manager).
   Always set it to the path of the project the work targets, written as `~/Projects/<repo>`
   (the parser expands `~` to `os.homedir()` at ingest, so the same PRD works on any machine).
   Avoid hardcoding an absolute home path (`/home/<you>/Projects/<repo>`); it breaks on any
   machine with a different home directory.

   **Required body sections, in this order:**
   ```markdown
   # Goal

   <2-4 sentences. What the executor will build and why it matters. NO "as a user I want to"
   framing. Concrete: name the function, the file, the user-visible change.>

   # Acceptance criteria

   - [ ] <each line is a verifiable check the executor can run after building>
   - [ ] <include explicit file paths, function names, expected behavior>
   - [ ] a bounded test command passes, e.g. `timeout 300 npm run typecheck` / `pytest -x` /
     `cargo check` (the run-before-done / never-end-on-red rule lives in standards.md →
     Execution discipline; the AC just has to name the command).

   # Implementation notes

   <file paths the executor will need to read first; the architectural pattern to follow; any
   non-obvious constraints. Be specific. Quote function signatures if it saves the executor a
   Read call.>

   # Out of scope

   <short bulleted list of what NOT to build, to prevent scope creep>
   ```

   **Self-containment is load-bearing.** The executor (`claude -p`) starts with NO conversation
   context — only the PRD body and the project files. So: include exact file paths (e.g.
   `src/main/index.cjs:142`); quote function signatures or relevant code blocks if the executor
   would have to grep for them; name the libraries/patterns to use (e.g. "use the existing
   `validatePath` helper in `config.cjs`"); don't reference "the conversation we just had" or
   "the design we discussed"; if a PRD depends on another PRD's output, say so in
   `# Implementation notes` AND give it a higher `NN` so it queues after.

   **Scope sizing — keep it SMALL (data-driven, 2026-06).** Across 400+ real runs the median
   PRD finishes in **~7 minutes**, p90 **~21 min**, p99 **~66 min** — yet authored
   `estimateMinutes` ran 5–8× too high. Oversized scoping anchors PRDs too big and pushes them
   into the rare >60-min tail where ~100% of true hangs live (deploy poll-loops, unbounded e2e
   suites). Target ~15 minutes of wall-clock work per PRD — **hard ceiling ~30 min; if you
   project more, SPLIT** into sequential `NN` PRDs and document the dependency in each. Set
   `estimateMinutes` realistically: **p50≈8, p90≈21** — don't write 60/90, it's almost always
   wrong and hides real outliers. Each execution costs ~$0.50–$2; smaller PRDs = smaller blast
   radius when a run is rate-limited, timed out, or killed. **`rateLimited` exit-1 is NOT a
   failure** — it's the scheduler's designed auto-pause; the job auto-resumes at the next
   window reset. Don't add retry logic for it.

4. **Emit each PRD** to the canonical path and structure above, then **append `## Engineering
   standards` and paste the full contents of `standards.md` verbatim.** This is the
   load-bearing step — it's the only way the standards (incl. Execution discipline) reach the
   headless run. Honor the `PRD_AUTHORING.md` §10 pre-queue checklist.

5. **Confirm to the user**, per emitted PRD: filename, chosen `NN` + rationale
   (parallel-with-X / serial-after-Y), `cwd`, and an ETA + token-cost ballpark. Note they can
   "Run now" in the SchedulePanel or wait for `when-available` polling.

## Phase 2 — Track to completion (reusable tail)

The queued PRDs run headlessly and can take a while. Don't fire-and-forget, and don't block —
hand off to a recurring check. `/process-feedback` delegates to this exact phase, so it is the
single definition of "tracked to done" for both entry paths.

6. **Watch the scheduler every ~30 min.** Start a 30-minute monitoring loop (`/loop 30m` over
   this watch step, or a `ScheduleWakeup` at 1800s if self-pacing) scoped to the PRD ids you
   emitted. On each tick, read the scheduler's job status (queue + run history under
   `~/.claude/session-manager/scheduled-plans/`, or the SchedulePanel) and branch:
   - **Still queued / running, within its window** — leave it; re-check next tick.
   - **Failed / errored / `needs_review` / timed out / killed by the watchdog or supervisor /
     overran its estimate badly** — STOP waiting and surface it now: which PRD, the failure
     signal, the relevant log tail, and the likely cause (a stuck poll-loop or post-AC overrun
     per `PRD_AUTHORING.md`). Don't silently retry forever. A `rateLimited` exit-1 is the
     scheduler's benign auto-pause (auto-resumes next window) — keep waiting, don't escalate.
   - **All PRDs completed successfully** — go to step 7.

7. **Gate: definition of done** (same for both entry paths). Once the code has landed:
   - **Verify live against each PRD's acceptance criteria** — run the health check, hit the
     endpoint, show before/after. The headless run asserted its own test command; this is the
     interactive confirmation it actually does what was asked.
   - For a **major feature or risky change**, dispatch a review via the
     `requesting-code-review` skill before calling it done; fix Critical/Important findings.
   - **Report back**: what landed, PRD/commit refs, verification result, anything left open.

## References (reuse, don't duplicate)

- `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` — the §1–§10 safety rules.
- `~/.claude/skills/develop/standards.md` — the engineering + execution-discipline rules inlined into every PRD.
- `test-driven-development`, `systematic-debugging` — interactive dev sessions.
- `requesting-code-review` — the Phase-2 review gate.

## Notes

- Write PRD files directly, then confirm — don't draft them inline in chat for review first.
- Don't combine unrelated features into one PRD. One focused, completable unit each.
- Don't add a `parallelGroup` frontmatter key — the filename `NN-` prefix drives grouping.
- Don't write a PRD to `data/prds/`, `docs/prds/`, the project's own folder, or anywhere outside
  the canonical path. The user has explicitly flagged this as a recurring problem.
- Don't leave `cwd` unset hoping for the default. Be explicit.
