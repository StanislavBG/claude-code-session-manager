---
title: Split adminServer.cjs into a shared transport + routes owned by their feature modules
cwd: ~/Projects/session-manager
estimateMinutes: 28
---

# Goal

`src/main/adminServer.cjs` is a single file bundling three unrelated concerns: (1) a generic
loopback-only HTTP server with bearer-token auth (bootstrap, token generation/persistence,
timing-safe comparison, body reading, JSON responses), (2) job-management route logic
(`GET /admin/scheduler/jobs`, `POST /admin/scheduler/reset-job`) that is a thin pass-through to
`scheduler.cjs`'s already-exported `remote.listJobs`/`remote.resetJob` (`scheduler.cjs:3214+`),
and (3) PRD-creation route logic (`POST /admin/scheduler/create-prd`) that duplicates
PRD-authoring concerns already owned by `src/main/lib/prdCreate.cjs`
(`buildPrdBody`/`deriveSlugFromTitle`/`readStandards`/`PRD_CREATE_SLUG_RE`) plus
`remote.allocateParallelGroup`/`remote.writePrd`/`remote.readPrd`.

This file exists so that `scripts/scheduler-mcp-server.cjs` (an out-of-process MCP server,
registered in `.mcp.json`, exposing `scheduler_list_jobs`/`scheduler_reset_job`/
`scheduler_create_prd`) can reach the running Electron app's in-memory scheduler state safely —
that capability must be preserved exactly (these MCP tools are actively used). What should change
is *where the route logic lives*: right now it's centralized in an infra-named grab-bag file
instead of living beside the feature it serves. This PRD keeps the transport (loopback HTTP +
token auth) as the one genuinely generic, reusable piece, and moves each route's actual logic to
the module that already owns the underlying capability — matching this project's existing
"one concept, one implementation, co-located with its owner" convention (already applied this
session to `transcripts.cjs`'s classifier extraction, PRD 687).

# Acceptance criteria

- [ ] Create `src/main/lib/localAdminHttp.cjs` containing ONLY the generic transport, extracted
  verbatim from `adminServer.cjs`: `timingSafeEqualStrings`, `readBody`, `sendJson`,
  `TOKEN_PATH`/`ensureToken`/`persistPort`/`authorized`, the `http.createServer` bootstrap
  (`start`/`stop`), and a route-registration mechanism — e.g. `createAdminHttp()` returns
  `{ start, stop, registerRoute(method, url, handler) }` where `registerRoute` accumulates
  `(method, url) → async (req, res, parsedBody) => void` handlers into a dispatch map, and the
  server's request handler (currently `handleRequest` in `adminServer.cjs`) becomes a generic
  dispatcher: authorize → look up `${method} ${url}` in the map → call the handler → 404 if no
  match. Preserve the exact security posture (127.0.0.1-only bind, OS-assigned port, 0600 token
  file, `crypto.timingSafeEqual`) unchanged.
- [ ] In `src/main/scheduler.cjs`, add a function (e.g. `registerAdminRoutes(adminHttp)`) that
  registers the two job-management routes directly against the injected transport:
  `GET /admin/scheduler/jobs` → `remote.listJobs()`; `POST /admin/scheduler/reset-job` → parse
  body, extract `slug`, 400 if missing, call `remote.resetJob(slug)`. This is the exact logic
  currently in `adminServer.cjs`'s `handleRequest` for these two routes, moved verbatim — no
  behavior change. Export this function from `scheduler.cjs`'s existing `module.exports` list.
- [ ] In `src/main/lib/prdCreate.cjs`, add a function (e.g. `registerAdminRoute(adminHttp, remote)`)
  that registers `POST /admin/scheduler/create-prd` with the exact logic currently in
  `adminServer.cjs`'s `handleRequest` for that route — body parsing, `schemas.schedulerCreatePrd`
  validation, `config.validatePath(expandHome(input.cwd))` (reuse `config.cjs`/`expandHome.cjs`
  exactly as today, don't fork the validation), slug derivation, `remote.allocateParallelGroup()`
  (unless caller supplied `parallelGroup`), the existing-file collision check via
  `remote.readPrd(filenameSlug)`, `prdCreate.readStandards()`, `prdCreate.buildPrdBody(input,
  standardsText)`, `remote.writePrd(filenameSlug, body)` — moved verbatim, not rewritten. Since
  this logic already lives conceptually in `prdCreate.cjs`'s domain (it already imports
  `prdCreate.deriveSlugFromTitle`/`PRD_CREATE_SLUG_RE`/`readStandards`/`buildPrdBody` today), this
  consolidates route + domain logic into one file instead of splitting them across `adminServer.cjs`
  and `prdCreate.cjs`.
- [ ] Update `src/main/index.cjs`: replace `const { createAdminServer } = require('./adminServer.cjs');
  const adminServer = createAdminServer(scheduler.remote);` with
  `const { createAdminHttp } = require('./lib/localAdminHttp.cjs'); const adminHttp =
  createAdminHttp();` plus calls to `scheduler.registerAdminRoutes(adminHttp)` and
  `prdCreate.registerAdminRoute(adminHttp, scheduler.remote)` (both called once, alongside the
  existing `adminServer.start()`/`.stop()` call sites at lines ~1089 and ~1200 — rename those
  local references to `adminHttp.start()`/`.stop()`).
- [ ] Delete `src/main/adminServer.cjs` once nothing requires it (grep to confirm no other
  importer exists before deleting — `bin/cli.cjs` and `scripts/scheduler-mcp-server.cjs` don't
  import it directly today per earlier investigation, only `index.cjs` does).
- [ ] `scripts/scheduler-mcp-server.cjs` and `.mcp.json` are unaffected — they only ever talked to
  the HTTP routes by URL/token, never imported `adminServer.cjs` directly, so no changes needed
  there; confirm this by reading `scripts/scheduler-mcp-server.cjs` before finishing, don't just
  assume.
- [ ] Preserve exact external behavior: same three routes, same URLs, same request/response
  shapes, same token file path/format (`~/.claude/session-manager/admin-api.json`), same security
  posture. This PRD is a pure internal reorganization — a caller of any of the three HTTP routes
  (including the live MCP tools) must see zero difference.
- [ ] Add/move unit tests: search `find src/main -iname '*admin*spec*' -o -iname '*admin*test*'`
  for existing `adminServer.cjs` tests first. Split them to follow the code: transport-level tests
  (auth rejection, token persistence, 404 on unknown route) move to
  `src/main/lib/localAdminHttp.spec.cjs`; job-route tests move alongside `scheduler.cjs`'s
  existing spec file; create-prd-route tests move alongside `prdCreate.cjs`'s existing spec file
  (or a new one matching that directory's naming convention if none exists yet). Don't lose
  coverage in the split — every existing adminServer test case must still exist somewhere after
  this PRD, just relocated to match its new owner.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <all test files you touched>` passes.

# Implementation notes

- Read `src/main/adminServer.cjs` in full first (it's only 243 lines) — this PRD is almost
  entirely a mechanical relocation of existing, working code, not a rewrite. Resist "improving"
  logic while moving it.
- The dependency-injection pattern `adminServer.cjs` already uses (`createAdminServer(remote)` —
  "so this module stays testable without booting Electron", per its own header comment) should
  carry over to the new structure: `scheduler.registerAdminRoutes` and `prdCreate.registerAdminRoute`
  should both take the transport (and `remote`, for the prdCreate one) as explicit parameters, not
  reach for a module-level singleton — keeps both testable in isolation exactly as today.
- `scheduler.cjs` already has a giant `module.exports` list (`~line 3330`) — add
  `registerAdminRoutes` to it rather than creating a new export surface pattern.
- Read `prdCreate.cjs`'s existing exports (`buildPrdBody`, `deriveSlugFromTitle`, `readStandards`,
  `PRD_CREATE_SLUG_RE`) before adding `registerAdminRoute` — match its existing module style.

# Out of scope

- Do not change the actual HTTP route URLs, request/response JSON shapes, or auth mechanism —
  this is a pure code-organization change, not an API change.
- Do not change `scripts/scheduler-mcp-server.cjs` or `.mcp.json` unless your read of
  `scheduler-mcp-server.cjs` (per the AC above) reveals it imports `adminServer.cjs` directly
  (unexpected, but verify rather than assume) — in that unlikely case, update its import path only,
  nothing else.
- Do not add a 4th admin route or expand scope beyond what `adminServer.cjs` does today.
- Do not touch `scheduler.cjs`'s or `prdCreate.cjs`'s existing non-admin-route logic.

## Engineering standards

# Engineering standards

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

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
- **A shared-repo `cwd` can be occupied by a concurrent job — check before you touch shared state.** When a PRD's `cwd` is a repo other headless runs may also target (a shared team repo like sigma, not a private single-purpose project), a `git checkout`/`gh pr checkout` can land you in another job's live worktree with its own uncommitted WIP. Before running `git stash`, `git reset`, or any command that discards or hides working-tree state, check `git stash list` and `git status` first, and if you must set aside pre-existing uncommitted changes that aren't yours, **stash with a descriptive message** (`git stash push -m "pre-existing WIP found by PRD <NN>, not mine"`) and **restore it before your run ends** (or, if you can't safely restore because your own commit depends on that worktree state, leave it stashed with the message and say so explicitly in your finish output — never let the run end silently dropping someone else's stash). Never `git stash drop`/`git clean -fd` on state you didn't create. (Incident: PRD 477 stashed a concurrent job's rAF-throttle-revert WIP to get its own checkout, finished, and exited without restoring it — orphaning the other job's uncommitted work in `stash@{0}` with no record of whose it was.)
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Prefer a small temp `.js` file over a fragile multi-quote one-liner.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** Wrap it so the cap is a success-with-note rather than a bare `Exit code 124`.
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate.
- **Don't leak expected-error text into tool output.** When a step is *expected* to error, capture it and surface a clean token instead of the raw exception.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** Order the run so the last command is the green AC gate — do any intentionally-failing step early, never after the gate.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** Never print `PASS` when the gate is red.
