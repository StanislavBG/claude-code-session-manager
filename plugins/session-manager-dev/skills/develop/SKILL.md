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
single-PRD structure/sizing belongs to `/prd`, the engineering rules belong to `standards.md`.
Reference them; don't fork them.

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

3. **Decompose into a series of SMALL, bounded PRDs.** This is the part `/develop` owns that
   `/prd` doesn't: split a large ask into multiple PRDs and sequence them. For each PRD's
   *size, command-bounding, `NN` parallel group, and structure*, follow `~/.claude/skills/prd/SKILL.md`
   — it is the canonical authority; do not restate its rules here. To pick `NN`, **compute the
   highest in-use number deterministically — never eyeball or narrow-grep the `ls`** (a
   narrowed pattern like `'^10[0-9]'` silently misses `110+` and collides):
   ```bash
   ls ~/.claude/session-manager/scheduled-plans/prds/ | grep -oE '^[0-9]+' | sort -n | uniq | tail -5
   ```
   The last line is the current max. Then: same `NN` as a logically independent sibling that
   can run in parallel; **next free `NN` = max+1** when this PRD hard-depends on prior work or
   is unrelated to every existing group. Record each cross-PRD dependency in the dependent
   PRD's notes.

4. **Emit each PRD** to the canonical path per `/prd`'s structure, then **append `## Engineering
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

- `~/.claude/skills/prd/SKILL.md` — canonical single-PRD structure, location, filename rules, scope sizing.
- `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` — the §1–§10 safety rules.
- `~/.claude/skills/develop/standards.md` — the engineering + execution-discipline rules inlined into every PRD.
- `test-driven-development`, `systematic-debugging` — interactive dev sessions.
- `requesting-code-review` — the Phase-2 review gate.

## Notes

- Write PRD files directly, then confirm — don't draft them inline in chat for review first.
- Don't combine unrelated features into one PRD. One focused, completable unit each.
- Don't add a `parallelGroup` frontmatter key — the filename `NN-` prefix drives grouping.
