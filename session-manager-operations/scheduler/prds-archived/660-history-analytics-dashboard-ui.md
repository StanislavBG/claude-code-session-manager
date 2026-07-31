---
title: Replace History dashboard with the Usage Analytics design (rollup-only, zero scan)
cwd: ~/Projects/session-manager
estimateMinutes: 28
---

# Goal

Replace the History tab's dashboard view (src/renderer/components/tabs/HistoryDashboard.tsx,
814 lines) with the "Usage Analytics" Claude Design page: one global measure + range that
drives every panel — sticky control bar, project facet chips, headline band with delta vs
prior window + area spark, stacked-by-project daily trend (absolute/share), ranked project
table with per-project drill (model mix + tool mix), and composition panels (Model mix,
Concentration, Cache leverage, Weekday rhythm). All data comes from PRD 659's
`window.api.history.dashboard()` — the view never triggers a transcript scan.

# Acceptance criteria

- [ ] `HistoryDashboard.tsx` rewritten (subcomponents under
      src/renderer/components/tabs/history/analytics/ — keep files small: Headline,
      ProjectFacet, StackedTrend, Ranking, ProjectDrill, panels). History.tsx's outer
      tab/sub-view routing and SessionLog.tsx are untouched.
- [ ] Control bar (sticky within the pane): measure segmented control — In tokens, Out
      tokens, Total tokens, Prompts, Sessions, Time (activeMinutes), Spend — and range
      segmented control — 30d / 60d / 90d / All time — plus `N / M projects` indicator,
      from→to dates, and a Refresh button that re-invokes the IPC only (never a scan).
      Selected measure+range persist to localStorage (`sm.history.analytics.*`).
      Token-measure definitions (state them in a code comment, single source in the
      view-model): In = inputTokens + cacheReadTokens + cacheCreationTokens (all tokens
      submitted); Out = outputTokens; Total = In + Out. All three flow through every panel
      (headline, stacked trend, ranking, facets) like any other measure.
- [ ] Project facet chips: click toggles a project in/out of EVERY panel's computation;
      shift-click isolates; "show all (N)" resets; faceting recomputes totals/deltas/days
      client-side from the per-project day buckets (pure helper `facetSlice(data, keep)` in
      src/renderer/lib/historyFacet.ts with unit tests — the A_FACET semantics from the
      design: totals, deltas, per-day recompute, model-mix rescale, active-day recount).
- [ ] Headline band: big value for the active measure, delta vs the prior equal-length
      window (green/red, inverted coloring for Spend where down=good; hidden with "no prior
      window to compare" when prev window incomplete), per-active-day + per-session +
      active-days + projects-touched substats, and an area sparkline of the daily series.
- [ ] Stacked trend: SVG stacked area by project (biggest at bottom), absolute/share toggle,
      click a band to select that project, dimming non-selected bands; y-axis gridlines +
      formatted tick labels; x labels thinned (~8). Project colors from the existing
      hashed-dot palette (`sched-primitives.tsx` ProjectTag hashing — reuse the hash, do NOT
      import Almanac visual components; extract the hash→color helper into a shared
      renderer lib if it currently lives only in sched-primitives).
- [ ] Ranking table: sorted by active measure — dot+name, share bar, value, share %, trend
      delta, sessions, top tool. Row click selects; ProjectDrill card below with 6 stats +
      model-mix list + tool-mix bars and a clear button. Selection clears when the project
      is faceted out.
- [ ] Composition row: ModelMix (share bar + list, model names via lib/prettyModel.ts),
      Concentration (top-3 share + distribution bar + long-tail note), CachePanel (donut
      hit-rate + reused tokens, PLUS a cache-write line: cacheCreationTokens for the range,
      labeled "written to cache", so read and write are both visible), Rhythm (7-bar weekday
      with peak highlight + weekend share).
- [ ] CSV export: an "Export CSV" button in the control bar downloads the CURRENT facet+range
      daily series, computed client-side from the already-loaded payload (no IPC, no scan).
      Columns exactly: date, cost_usd, input_tokens, output_tokens, cache_write_tokens,
      cache_read_tokens, total_tokens, cache_hit_pct, num_models, top_model — one row per
      day (num_models = distinct models with nonzero tokens that day; top_model = highest
      total-token model that day, prettyModel-shortened; cache_hit_pct = cache_read /
      (input + cache_read + cache_write), 1 decimal). Pure row-builder helper
      `buildUsageCsv(days)` in src/renderer/lib with unit tests (escaping, empty day,
      the pct rounding). Download via Blob + anchor, filename
      `usage-history-<from>-<to>.csv`.
- [ ] Monthly budget preserved (deviation from the design, by intent): the existing budget
      strip (month-to-date, run-rate projection, cap input + over-cap warning) survives as a
      slim panel under the headline, fed month-to-date from the same dashboard payload
      (Spend measure over the current calendar month) — read how the current
      HistoryDashboard computes/stores the cap before rewriting; keep its storage key.
- [ ] Empty/loading/error states: skeleton while the IPC resolves; toast.error + retained
      last data on failure; explicit empty state when the rollup has no rows in range.
- [ ] Visual language — CORRECTION: the repo's Tailwind tokens ARE the Almanac paper palette
      (tailwind.config.js: bg → #f6efe1, accent → #b85c34, font-serif → Newsreader,
      font-mono → IBM Plex Mono). Match the design's CSS as closely as possible: serif
      display h1 + section titles, mono numerals, 14px card radius, sticky blurred paper
      control bar, delta colors #566b34/#a3441f, dim band #ded2bd. See the sibling
      660-fix PRD's "Visual language — CORRECTION" block for the full fidelity list — it is
      the authoritative styling spec for this work. Extract the design's aFmt formatters
      into src/renderer/lib/analyticsFormat.ts with unit tests (usd/tok/int/min/pct incl.
      the <1% and k/M/B thresholds).
- [ ] TDD, red first: unit tests for analyticsFormat, facetSlice, and the stacked-band
      cumulative math (pure helper returning band paths' underlying series, not SVG).
- [ ] `timeout 300 npm run typecheck` and `timeout 420 npm run test:unit` pass. Do NOT run
      the e2e suite.

# Implementation notes

Depends on PRD 659 (`window.api.history.dashboard`) — verify present or exit 1.

Read first: src/renderer/components/tabs/HistoryDashboard.tsx (what exists: stat cards,
budget strip, daily metric line chart, spend-by-model, cache savings — the budget logic and
its localStorage/config key are the part to carry over), History.tsx (sub-view routing),
tabs/history/SessionLog.tsx (untouched), sched-primitives.tsx PROJ_DOTS/hashStr (:12-33),
lib/prettyModel.ts, state/toast.ts.

Design source (structure to port): Claude Design project "Session Manager" →
"Usage Analytics.html" + variants/analytics.jsx (panel semantics: Headline substats,
A_FACET recompute rules, StackedTrend abs/share modes, Ranking columns, ProjectDrill,
Concentration top-3, CachePanel donut, Rhythm weekday) + variants/analytics-data.jsx
(the S-slice shape: days/totals/prevTotals/deltas/rows/byModel/cache/activeDays — mirror
this as the renderer-side view-model computed from the IPC payload).

Project identity: the rollup keys projects by encoded projectDir — label = last path
segment(s) decoded (reuse decodeCwd semantics via the payload; the IPC should already send
a display label — check PRD 659's response, derive if absent).

# Out of scope

- SessionLog / session list, resume actions (History tab scope stays analytics-only for
  this view). The old history:aggregate IPC removal. Export/share features. Per-hour
  charts. Light-theme variant.


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
- **`gh pr edit --body` can fail on repos with legacy GitHub Projects (classic) boards** — the underlying GraphQL query fetches `repository.pullRequest.projectCards`, a field GitHub is sunsetting, and errors with `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)` even though the edit itself would otherwise succeed. This is a known `gh` CLI quirk, not a defect in your work. Prefer `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body="$(cat body.md)"` for updating a PR description headlessly — it doesn't touch the deprecated field. If you do use `gh pr edit` and it fails this way, don't leave the bare GraphQL error as the last thing in that step (it reads as an unrecovered error in the final-20%-of-transcript verifier heuristic): immediately retry with the `gh api` form and print one line noting the known-bug fallback, so the recovery is adjacent to the error.
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). Two executor habits cause it: (1) **throwaway probes that error** — an inline `python -c` with a quoting/f-string slip, a wrong kwarg, a bad path. When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Don't move on leaving a bare error as the last thing in that step. Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner (inline f-string errors are the top source of stranded tracebacks). (2) See the timeout rule below.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** `timeout`-capping a genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is correct — but a bare `Exit code 124` reads as a failure to the verifier. Wrap it so the cap is a success-with-note: `timeout 120 <cmd> || { rc=$?; [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial, rows persist incrementally; OK" || { echo "HALT: <cmd> failed rc=$rc"; exit 1; }; }`. (Distinguish 124 = expected cap from a real non-zero.) For work that legitimately needs longer than a safe cap, run it in the background and poll a bounded number of times rather than capping the foreground command.
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.
