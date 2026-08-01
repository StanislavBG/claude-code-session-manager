---
name: develop
description: >-
  Lead a software-development task by analyzing it from multiple angles (positive path, edge
  cases, interaction effects, integration, UI validation) and decomposing it into a series of
  self-contained PRDs — either a handful of independent small PRDs, or a 3-5 PRD evolving chain
  with sub-tasked acceptance criteria for larger asks — queued for the session-manager
  scheduler, each pointing the headless executor at the engineering standards file to read at
  runtime — then track those PRDs to completion, verify them against their acceptance criteria,
  and report back. Use whenever the user says "/develop", "develop X", "build me X", "implement
  X", "let's code X", or otherwise starts dev work that should run as scheduled PRDs rather than
  inline now. This skill is the home for the developer-only guidance (performance, debugging,
  API-reuse, TDD) that was removed from the always-on global CLAUDE.md. Keywords: develop,
  build, implement, code, feature, refactor, bugfix, queue dev work, PRDs, PRD chain, multi-angle
  analysis.
---

# /develop — prompt → scheduled PRDs → tracked to done

**Role:** `/develop` owns the *pipeline*: it turns a development request into one or more
self-contained PRDs, queues them, and tracks them to completion. It is the convergence point
for both entry paths — an interactive human prompt inside an Epic's own conversation comes
straight here; an agent feedback file arrives as an approved Epic proposal (`/propose-epic`),
which the user approves and then calls this skill. Everything from here on is identical
regardless of who asked.

**Epic-gated — non-negotiable.** `/develop` may only run inside an already-existing,
already-human-approved Epic's own conversation (Chat or Terminal — the two views over one Epic
session, per the domain model). It never creates an Epic itself and never writes a PRD against
one it had to guess at. Before doing anything else:
1. Resolve `<epic-id>`: this conversation's own claudeSessionId must already match an Epic's
   `claudeSessionId` in `<cwd>/session-manager-operations/prompt-sessions/active-index.json` —
   that Epic's `id` is `<epic-id>` for every PRD authored in this pass.
2. If it doesn't match any Epic — this was invoked as a bare standalone command outside any
   Epic context — **stop and say so**. Tell the human to create the Epic first (the New Epic
   card in the app, or `/propose-epic` + **Approve & start**), then re-run `/develop` from
   inside that Epic. Do not mint one yourself, do not fall back to writing an epicless PRD, and
   do not proceed with authoring.

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
and the executor-facing Execution discipline) live in **`standards.md`** beside this file, in
the same skill directory (`.../skills/develop/standards.md` — NOT `~/.claude/skills/develop/`,
which is a different, non-existent path; resolve it relative to wherever this SKILL.md itself
was loaded from).

**Reference it, don't embed it.** The headless executor (`claude -p`) runs on the same
filesystem this authoring session does, with full tool access — so a PRD only needs to name
`standards.md`'s absolute path (resolved once, at authoring time, the same way this file already
resolves it) and instruct the executor to `Read` it before starting. There is now exactly one
copy of this text on disk, ever — no pasted snapshot to go stale, and nothing to re-read fresh
before writing (an earlier version of this skill pasted the full contents into every PRD and had
to warn authors to re-read it fresh each time to avoid shipping a stale in-context copy — PRDs
467/468 did exactly that and repeated an anti-pattern a guard added earlier the same session was
meant to prevent. Referencing by path removes the failure mode instead of warning against it).
Never restate or fork its content — one concept, one implementation, one location.

For interactive dev work, also apply the `test-driven-development` and `systematic-debugging`
skills; the headless PRDs get the distilled core from `standards.md` instead, since they
can't load skills.

## Phase 1 — Author + queue the PRDs

1. **Clarify scope first.** If the prompt has genuine ambiguity (acceptance criteria, target
   repo, framework, edge cases), ask 2–4 focused questions as plain text and wait. Don't use
   the AskUserQuestion tool. Don't guess on decisions that would cost real rework. (When the
   caller is an approved Epic proposal, scope is already established by its objective — don't
   re-ask; build from the brief it hands you.)

2. **Explore the target repo — broadly, not just the obvious file.** Identify the absolute
   `cwd`, existing patterns/utilities to reuse (per the API-reuse standard — search before
   writing new code), the test command, and any constraints. Capture exact file paths and
   signatures; they go straight into the PRDs. Don't stop at the first component that looks
   relevant — check its siblings too (does the same pattern appear in 2-3 similar components?
   do they actually share the same shape, or only look similar — confirm by reading, don't
   assume: a wrong assumption here means an inaccurate PRD, discovered only after the executor
   runs it), check existing tests for the area, and check whether a prior PRD already touched
   this subsystem (`ls <cwd>/session-manager-operations/scheduler/epics/*/prds/` for related slugs, in
   the target repo) — duplicating or contradicting a still-queued PRD is a real failure mode,
   not a hypothetical one.

3. **Analyze the request through five named lenses, draft a candidate decomposition, then run
   a completeness pass before finalizing it.** This step exists because small, bounded individual
   PRDs (step 4) are correct and non-negotiable — but a *set* of small PRDs can still be
   incomplete if the upfront decomposition missed something. Keeping PRDs small is not a
   substitute for getting the decomposition right; it's a separate concern, and this step is
   where decomposition depth and breadth get checked.

   **The five lenses.** Before drafting the PRD list, look at the request through each of these
   explicitly — not as a vague "think it through" gesture, but as five concrete questions you can
   answer in a sentence each. Skipping a lens silently is how a decomposition ships narrow:
   - **Positive path.** What does the request look like when everything goes right? Name the
     concrete user-visible or system-visible outcome — this anchors the core PRD(s).
   - **Edge cases.** What inputs/states break the happy-path assumption? Empty/zero/max states,
     concurrent access, malformed input, permission boundaries, network/process failure.
   - **Interaction effects.** Does this change anything that another feature, panel, store, or
     in-flight state already depends on? A layout change can break a responsive breakpoint; a
     new field can desync two stores that used to agree; a UI merge can silently drop a
     conditional-render gate another feature relied on. Naming this explicitly is what catches
     the "it works in isolation but breaks its neighbor" class of bug.
   - **Integration.** Does this correctly compose with the existing architecture at its
     boundaries — the IPC schema, the shared store, an existing API contract, an established
     design-primitive file — rather than reimplementing a parallel path? This is the API-reuse
     standard (`standards.md`) applied at the planning stage, before code exists to duplicate.
   - **Validation (UI/visual, planned up front — not just checked at the end).** For any ask
     that touches UI or visual output, decide *now*, while drafting, exactly how it will be
     confirmed working before it's called done: what screenshot/state to capture, light AND dark
     mode if the project has both, and which specific acceptance line will prove it (not "looks
     right" — a concrete, checkable claim). Bake that plan into the PRD's own Acceptance
     Criteria (see step 4's sub-tasked AC) rather than leaving visual confirmation as an
     afterthought bolted on at the step 8 gate — deciding the validation method during design
     surfaces gaps (e.g. "there's no existing screenshot tooling for this surface") while there's
     still time to plan around them, instead of discovering it mid-execution.

   - For a **genuinely trivial ask** (one obvious PRD, no cross-file consequences, all five
     lenses come back empty) — skip straight to step 4, no ceremony needed.
   - For anything **larger than one or two obvious PRDs, or touching more than one
     component/subsystem** — before finalizing, dispatch a second, independent agent (the Agent
     tool, `subagent_type: "Explore"` or `"general-purpose"` — this is a single extra dispatch,
     not the full multi-agent Workflow tool, and needs no special opt-in) with: the original ask
     verbatim, your draft PRD list (titles + one-line goals), and the five lenses above by name,
     instructing it to find what's missing under each one — uncovered edge cases, error-handling
     paths, tests, cross-feature/cross-state interaction effects, integration points that would
     be reimplemented instead of reused, components that share the same pattern but weren't
     included, anything the draft assumed without verifying. Treat its findings as a second
     opinion to weigh, not an automatic addition — fold real, concrete gaps into the PRD set (add,
     split, or adjust a PRD); dismiss vague or speculative ones. For a large, multi-subsystem ask,
     it's fine to repeat this once more after folding in the first round's findings (a second
     completeness pass on the revised set) — stop once a pass turns up nothing new, don't loop
     indefinitely.
   - **Check each drafted PRD against explicit concern dimensions, not just "does the feature
     work"**: missing features/edge cases beyond the happy path, interaction effects, integration,
     tests, security, and quality (perf, error handling). This is where depth actually comes
     from — a decomposition that only ever asks "what file does this touch" produces exactly the
     narrow, single-concern PRDs this step exists to catch.
     - **Tests and security are NOT separate follow-up PRDs — they are mandatory AC lines inside
       the SAME PRD as the feature they belong to.** This is non-negotiable: `standards.md`'s TDD
       rule requires the test before/with the implementation, not after, and a security concern
       (input validation at a boundary, auth checks, no string-built queries) is a decision made
       while writing the code — a later "security review PRD" would just end up re-touching the
       same lines, doubling work and leaving the shipped code insecure in the meantime. Every
       feature PRD's own Acceptance Criteria must include its test command AND, when it touches
       input/auth/data, the relevant security checks — don't spin these out.
     - **Genuinely separable work MAY become its own sibling PRD**: deeper edge-case coverage
       beyond what the core AC needs to prove correctness, performance/observability hardening,
       docs. Splitting these out is exactly the "more isolated, narrower PRDs" instinct — apply
       it here, where a dedicated PRD adds real value, not to tests/security where it subtracts
       from correctness.
   - This is a planning-quality step, not an execution step — it happens entirely in the
     interactive main-loop session, before anything gets written to disk or queued.

4. **Decompose into a series of SMALL, bounded PRDs.** Split the (now completeness-checked)
   decomposition into individually small PRDs and sequence them.

   **Two shapes — pick per request, don't default to one:**
   - **Independent set.** Most requests: a handful of small PRDs that can mostly run in
     parallel, each a self-contained unit (this is what "genuinely separable work" in step 3
     produces).
   - **Evolving chain (3-5 PRDs).** Use this shape when the request is naturally a sequence of
     stages that build on each other rather than independent units — e.g. scaffold → core
     behavior → edge-case/interaction hardening → integration wiring → UI validation pass. Each
     PRD in the chain: gets its own unique `NN` (numbers are strictly unique per project —
     PRD 832, user decision 2026-07-31) plus a `dependsOn: [<previous-link-slug>]`
     frontmatter line expressing the chain edge explicitly, and its
     `# Implementation notes` states in one line what the *previous* link actually delivered
     (file paths/functions it added, referencing its real landed state — not the plan for it,
     since PRDs 1..k-1 may have adjusted scope during execution) and what this link is expected
     to build on top of. Do not chain more than 5 deep — beyond that, re-run step 3's
     completeness pass instead of extending the chain further; a chain that long is a sign the
     original decomposition was wrong, not that it needs one more link. A chain does not relax
     the ~15-min/30-min-ceiling sizing below — each link is still individually small.
   - **Sub-tasked Acceptance Criteria** (either shape, when a single PRD legitimately spans more
     than one concern dimension from step 3 — e.g. it has both core-functionality and
     edge-case/interaction-effect checks): group the `# Acceptance criteria` checklist under
     sub-headings instead of one flat list, e.g. `## Core functionality`, `## Edge cases`,
     `## Interaction / integration`, `## Tests`. This is additive structure only — it does not
     change what step 4's "Required body sections" template requires (still exactly one
     `# Acceptance criteria` section overall), and it does not license combining what should be
     separate PRDs into one oversized one; if the sub-task groups would each take real time on
     their own, that's a signal to split into a chain link instead of one bloated PRD.

   **Prefer creating each PRD via the `scheduler_create_prd` MCP tool**
   (`mcp__session-manager-scheduler__scheduler_create_prd`) over hand-writing the file. Its input
   (`title`, `cwd`, `estimateMinutes`, `goal`, `acceptanceCriteria[]`, `implementationNotes`,
   `outOfScope[]`) maps directly onto the sections below — pass them straight through. **Always
   pass `sourcePromptId` explicitly, set to the `<epic-id>` resolved in the Epic-gated step
   above** — never omit it and rely on the server-side session-id fallback; that fallback exists
   only to cover a model that forgot, not as this skill's normal path, and the server refuses to
   write the PRD at all if no existing Epic resolves. It
   allocates a strictly-unique `NN` atomically (no read-then-write race against another
   concurrent `/develop` invocation, never reused across the project — PRD
   832), derives and collision-checks the slug, and embeds the standards pointer for you.
   `parallelGroup` is DEPRECATED and ignored — express ordering with the `dependsOn` input
   (slugs that must complete first); independent PRDs simply omit it and may run in parallel.

   **Fallback — only when the tool errors with "app not running" / admin API unreachable**
   (the session-manager Electron app must be running for this MCP tool to work; if it isn't,
   don't block on it): compute the highest in-use number deterministically yourself — never
   eyeball or narrow-grep the `ls` (a narrowed pattern like `'^10[0-9]'` silently misses `110+`
   and collides). PRDs are stored per-project, so `NN` allocation for a given PRD only needs
   *that project's own* prds directory scanned — not every project's:
   ```bash
   ls <cwd>/session-manager-operations/scheduler/epics/*/prds/ <cwd>/session-manager-operations/scheduler/prds-archived/ 2>/dev/null | grep -oE '^[0-9]+' | sort -n | uniq | tail -5
   ```
   (`<cwd>` is the target repo's absolute path — the same one this PRD's `cwd` field will use.)
   The last line is the current max within that project. Then: **always next free `NN` =
   max+1** — never reuse a sibling's number (unique-per-project rule, PRD 832); express
   ordering with `dependsOn: [<slug>]` frontmatter instead. This manual path has a
   small, accepted race (two concurrent authors could compute the same "next free" `NN`) —
   cosmetic (two unrelated groups end up sharing a number) rather than destructive, and only
   reachable when the atomic tool path above isn't available. Record each cross-PRD dependency
   in the dependent PRD's notes either way.

   ### PRD structure and location

   Each individual PRD must follow this structure — this is `/develop`'s single authority on
   one PRD's structure, location, and scope sizing (the engineering rules stay separate, in
   `standards.md`).

   You are writing a PRD that will be executed by the user's session-manager scheduler — a
   system that runs `claude -p <prd-body> --dangerously-skip-permissions` jobs around 5-hour
   token-window resets, with auto-pause on rate-limit and auto-resume.

   **Canonical location — non-negotiable.** Every PRD belongs to an **Epic** (the TAB → EPIC →
   PRD domain model in the project CLAUDE.md) — specifically the `<epic-id>` resolved in the
   Epic-gated step above. PRDs MUST be written to, inside the target repo:
   ```
   <cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/<NN>-<kebab-slug>.md
   ```
   Always pass that `<epic-id>` as `sourcePromptId` when creating each PRD — via the MCP
   `scheduler_create_prd` tool's `sourcePromptId` input, or, for the manual-write fallback, by
   resolving the directory with:
   ```bash
   node <session-manager-repo>/scripts/mint-epic.cjs <cwd> <epic-id>
   ```
   This only JOINS an existing Epic and prints its prds/ directory on the last stdout line — it
   never creates one. If `<epic-id>` doesn't exist yet, that means the Epic-gated step above
   wasn't satisfied; go back and get a human to create/approve the Epic first, don't work around
   this by minting one.

   **Anywhere else doesn't get scheduled or gets retired.** `data/prds/`, `docs/prds/`, and the
   old global `prds/` dir under `~/.claude/session-manager/scheduled-plans/` are invisible to
   the scheduler; the legacy flat `session-manager-operations/scheduler/prds/` dir is RETIRED —
   anything written there is auto-consolidated into `prds-archived/` at the next app boot
   without being executed. PRD *source* files are per-project and per-Epic, resolved at runtime
   via `src/main/lib/prdLocations.cjs`.

   **Filename rules.** `NN` is the PRD's unique per-project number (always next free =
   max+1 per the `ls` command above; ordering via `dependsOn` frontmatter, never via shared
   numbers). `<kebab-slug>` is a short, descriptive kebab-case identifier
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
   (When a PRD spans multiple step-3 concern dimensions, replace the flat `# Acceptance criteria`
   list above with sub-headings — `## Core functionality`, `## Edge cases`,
   `## Interaction / integration`, `## Tests` — each still a checklist of verifiable lines. See
   step 4's "Sub-tasked Acceptance Criteria" note. This is the only body section that may gain
   sub-headings; Goal, Implementation notes, and Out of scope stay flat.)

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

5. **Emit each PRD.** If you used `scheduler_create_prd`, this step is already done — the tool
   wrote the file to the canonical path with the standards pointer included; skip to step 5.
   **Fallback path only:** write to the canonical path and structure above, then **append `##
   Engineering standards` with a one-line pointer**, not the file's contents:
   ```markdown
   ## Engineering standards

   Before writing any code, read `<absolute path to standards.md, resolved above>` — it has the
   Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD.
   Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
   before done, the finish-protocol sentinel).
   ```
   This is the load-bearing step — it's the only way the standards (incl. Execution discipline)
   reach the headless run, and it now stays current automatically since the executor reads the
   live file rather than a snapshot taken at authoring time. Honor the `PRD_AUTHORING.md` §10
   pre-queue checklist.

6. **Confirm to the user**, per emitted PRD: filename, chosen `NN` + rationale
   (parallel-with-X / serial-after-Y), `cwd`, and an ETA + token-cost ballpark. Note they can
   "Run now" in the SchedulePanel or wait for `when-available` polling.

## Phase 2 — Track to completion (reusable tail)

The queued PRDs run headlessly and can take a while. Don't fire-and-forget, and don't block —
hand off to a recurring check. An approved proposal delegates to this exact phase, so it is the
single definition of "tracked to done" for both entry paths.

7. **Watch the scheduler every ~30 min.** Start a 30-minute monitoring loop (`/loop 30m` over
   this watch step, or a `ScheduleWakeup` at 1800s if self-pacing) scoped to the PRD ids you
   emitted. On each tick, read the scheduler's job status (queue + run history under
   `~/.claude/session-manager/scheduled-plans/`, or the SchedulePanel) and branch:
   - **Still queued / running, within its window** — leave it; re-check next tick.
   - **Failed / errored / `needs_review` / timed out / killed by the watchdog or supervisor /
     overran its estimate badly** — STOP waiting and surface it now: which PRD, the failure
     signal, the relevant log tail, and the likely cause (a stuck poll-loop or post-AC overrun
     per `PRD_AUTHORING.md`). Don't silently retry forever. For `needs_review`, the scheduler
     auto-files a Root Cause Analysis into the target project's feedback inbox
     (`rcaFeedbackHook`, filename `<date>-rca-<slug>-<runId>.md`) — reference that file in
     your report rather than re-deriving the analysis, and let the approving user fold its
     prevention hint back into future PRD authoring. A `rateLimited` exit-1 is the
     scheduler's benign auto-pause (auto-resumes next window) — keep waiting, don't escalate.
   - **All PRDs completed successfully** — go to step 8.

8. **Gate: definition of done** (same for both entry paths). Once the code has landed:
   - **Verify live against each PRD's acceptance criteria** — run the health check, hit the
     endpoint, show before/after. The headless run asserted its own test command; this is the
     interactive confirmation it actually does what was asked.
   - **Route to the specialist that actually matches what changed** — not always the generic
     reviewer. This environment has dedicated agents that sit unused unless explicitly called;
     match the PRD's surface to the right one before calling a major/risky change done:
     - Touches an API's request/response shape, REST/GraphQL contract, or endpoint design →
       dispatch `api-designer` (Agent tool).
     - Touches auth, input handling, secrets, or data storage → dispatch `security-auditor` in
       addition to the mandatory security AC the PRD's own execution already required — the
       auditor catches what the executor's self-check might miss.
     - Is a structural refactor (no behavior change intended) → dispatch `refactorer`.
     - Is performance-sensitive or touches a hot path → dispatch `perf-profiler`.
     - Adds or updates a dependency → dispatch `dependency-auditor`.
     - Touches a database schema, migration, or table design → **no specialist exists for this
       in this environment today.** Don't silently let the generic code-reviewer stand in for a
       schema review it isn't specialized for — say so explicitly in your report ("schema change,
       no dedicated reviewer available, manual review recommended") rather than implying coverage
       that isn't there.
     - Anything else, or a **major feature/risky change** not covered above — dispatch the
       generic `requesting-code-review` skill (`code-reviewer` agent) as the default.
     Fix Critical/Important findings from whichever specialist(s) ran before calling it done.
   - **Report back**: what landed, PRD/commit refs, which specialist(s) reviewed it (or the
     explicit "no specialist available" note), verification result, anything left open.

## References (reuse, don't duplicate)

- `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` — the §1–§10 safety rules.
- `standards.md` beside this file — the engineering + execution-discipline rules. Every PRD points the executor at its absolute path (see "Standards" above) rather than embedding a copy.
- `test-driven-development`, `systematic-debugging` — interactive dev sessions.
- `requesting-code-review` — the Phase-2 default review gate; `api-designer`, `security-auditor`,
  `refactorer`, `perf-profiler`, `dependency-auditor` — specialist agents routed to by surface
  area (see step 8) rather than always defaulting to the generic reviewer.

## Notes

- Write PRD files directly, then confirm — don't draft them inline in chat for review first.
- Don't combine unrelated features into one PRD. One focused, completable unit each.
- Don't add a `parallelGroup` frontmatter key — the filename `NN-` prefix drives grouping.
- Don't write a PRD to `data/prds/`, `docs/prds/`, the project's own folder, or anywhere outside
  the canonical path. The user has explicitly flagged this as a recurring problem.
- Don't leave `cwd` unset hoping for the default. Be explicit.
- Don't skip a step-3 lens silently and don't force every request into a chain — most asks are
  still an independent set of small PRDs; reach for the 3-5-PRD evolving chain only when the
  work is genuinely sequential (each link depends on the previous one's landed state), and never
  chain past 5 links.
