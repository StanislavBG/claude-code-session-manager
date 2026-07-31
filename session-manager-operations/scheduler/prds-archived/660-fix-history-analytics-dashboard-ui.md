---
title: "Fix: implement the History Usage Analytics dashboard inline (prior run self-delegated to /develop and shipped nothing)"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 660
estimateMinutes: 90
---

# READ THIS FIRST — why the previous run failed

The previous run of this work (`660-history-analytics-dashboard-ui`, run
`2026-07-25T04-36-10-589Z`) exited 0 after **producing zero code**. Instead of implementing
its acceptance criteria, it invoked the interactive `session-manager-dev:develop` skill from
inside the headless run, authored **four new PRDs** (`665-history-analytics-lib`,
`666-history-analytics-shell`, `667-history-analytics-trend-ranking`,
`668-history-analytics-composition`), called `ScheduleWakeup` to "track them", and ended its
turn with *"Now tracking to completion — I'll check back periodically."* There is no next
turn in a headless run. No diff. No commit. No verdict sentinel.

This is the canonical self-delegation failure. Quoting the rule verbatim from
`plugins/session-manager-dev/skills/develop/standards.md` § Execution discipline:

> - **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must
>   perform its own acceptance criteria directly. Do NOT invoke `/develop`,
>   `/process-feedback`, or any queue-authoring skill from inside a run — those are
>   interactive main-loop skills that author a *new* PRD and return, so the run exits 0
>   having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`).
>   Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run
>   ends and nothing re-invokes it. This applies just as much to spawning your own review
>   agents and waiting on them: do NOT invoke `/code-review`, `/security-review`,
>   `requesting-code-review`, or any other skill/subagent as a background/async step and then
>   end your turn with something like "I'll wait for the review agents to complete" — a
>   headless run has no next turn, so that line is the run's last output, no verdict sentinel
>   prints, and the job parks in `needs_review` even though the actual work already landed.
>   If a PRD's acceptance criteria call for a second review pass, run it **synchronously,
>   inline, before the finish protocol** — call the reviewer and read its result in the same
>   turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline
>   within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked
>   `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its
>   commit correctly but then backgrounded `/code-review --fix` + `/security-review` and
>   called `ScheduleWakeup` to "wait" for them — same class of failure, different entry
>   point.)

**A queued PRD is the task, not evidence that the task is done. The deliverable of this run
is a code diff committed to git.** You will not invoke `Skill`, `/develop`,
`/process-feedback`, `ScheduleWakeup`, `CronCreate`, or any scheduler MCP tool
(`scheduler_create_prd`) at any point in this run. The work below is large; decompose it
mentally into stages and execute every stage yourself, in this one run.

# Root cause

- **Trigger:** the PRD body is large (10 acceptance criteria spanning a lib layer, a control
  bar, a stacked-area chart, a ranking table, and four composition panels). The executor read
  "this is big" and reached for the decomposition tool it knows — `/develop` — which is an
  *interactive main-loop* skill.
- **Why it exited 0:** `/develop` succeeded at what it does (it wrote 4 PRD files and
  returned). Nothing errored, so the process exited 0. The scheduler's verifier then saw no
  `SCHEDULER_VERDICT` sentinel and no commit → `needs_review`.
- **Mechanism:** the global developer persona (`~/Projects/Agents/Developer/developer_sg.md`)
  routes *almost all* dev work through `/develop`. That routing rule has a hard exception for
  headless PRD execution, but the executor did not apply it. The inlined
  `## Engineering standards` block in the original PRD *did* contain the "You ARE the
  executor" rule; it was overridden anyway. Hence this fix-plan leads with the rule instead of
  burying it at the bottom.

# Fix steps

## Stage 0 — clear the duplicate queue entries (do this first, ~2 min)

The four PRDs the failed run spawned would duplicate and conflict with the work you are about
to do. Archive them so they never execute:

```bash
cd /home/bilko/.claude/session-manager/scheduled-plans
for s in 665-history-analytics-lib 666-history-analytics-shell \
         667-history-analytics-trend-ranking 668-history-analytics-composition; do
  if [ -f "prds/$s.md" ]; then
    mv "prds/$s.md" "prds-archived/$s.md"
    echo "archived $s (duplicate spawned by PRD 660's self-delegation)"
  else
    echo "already absent: $s"
  fi
done
```

Then return to the repo: `cd /home/bilko/Projects/session-manager`. Everything after this
point happens in that repo.

Do **not** hand-edit `queue.json` — the scheduler reconciles missing PRD files on its own.

## Stage 1 — orient (read before writing)

- `src/renderer/components/tabs/HistoryDashboard.tsx` (814 lines — the file being replaced).
  Note especially: the **monthly budget strip** logic and the exact localStorage/config key it
  stores the cap under. That key must survive verbatim.
- `src/renderer/components/tabs/History.tsx` (58 lines — outer routing + the current
  from/to/projectFilter toolbar that the new in-pane control bar supersedes).
- `src/renderer/components/tabs/history/SessionLog.tsx` — **untouched**.
- `src/main/historyDashboard.cjs` — the scan-free IPC that feeds this view. Confirm the exact
  response shape before coding the view-model: per-day rows carry
  `date, projectDir, promptCount, inputTokens, outputTokens, cacheReadTokens,
  cacheCreationTokens, toolCallCount, sessionCount, errorCount, activeMinutes, byModel{},
  estimatedCostUsd`, plus range `totals`, `prevTotals`, and `byModelTotals`. Read the file;
  do not guess field names.
- `src/preload/index.cjs:219` — `window.api.history.dashboard(req)` → `history:dashboard`.
  **Existence probe first:** if that IPC is absent, print one diagnostic line and `exit 1`.
- `src/renderer/components/tabs/scheduler/sched-primitives.tsx:1-35` — `PROJ_DOTS`,
  `hashStr`, `projectNameFromCwd`.
- `src/renderer/lib/prettyModel.ts`, `src/renderer/lib/historyMath.ts`,
  `src/renderer/lib/chartPalette.ts`, `src/renderer/state/toast.ts`.

`historyMath.ts` and `chartPalette.ts` already exist — **check them before writing any new
formatter or color helper.** Per the API-reuse standard: extend what is there rather than
adding a parallel copy.

## Stage 2 — pure lib layer, tests first (red → green)

Create under `src/renderer/lib/` (co-located `*.test.ts` next to each, matching the repo's
existing vitest convention — check how the neighbouring lib tests are named/placed and follow
it):

1. `projectColor.ts` — extract the `hashStr` → `PROJ_DOTS` mapping out of
   `sched-primitives.tsx` into a shared helper, and make `sched-primitives.tsx` import it so
   there is exactly one copy. Do **not** import Almanac visual components into the analytics
   view; only this hash→color helper is shared.
2. `analyticsFormat.ts` — `usd / tok / int / min / pct` formatters, including the `<1%` case
   and the k/M/B thresholds. Tests cover each threshold boundary.
3. `historyFacet.ts` — `facetSlice(data, keep)`: recompute totals, deltas, per-day series,
   model-mix rescale, and active-day recount from the per-project day buckets, client-side.
   Pure, no IPC. Tests cover: keep-all is identity, keep-none is a zeroed slice, model-mix
   rescale, active-day recount.
4. `analyticsViewModel.ts` — maps the raw IPC payload to the view-model
   (`days / totals / prevTotals / deltas / rows / byModel / cache / activeDays`) and resolves
   the active measure. **Token-measure definitions live here as the single source, stated in a
   code comment:** `In = inputTokens + cacheReadTokens + cacheCreationTokens` (all tokens
   submitted); `Out = outputTokens`; `Total = In + Out`. All three flow through every panel.
5. `stackedBands.ts` — cumulative band math for the stacked trend, returning the underlying
   per-band series (numbers), **not** SVG path strings. Tests cover absolute vs share mode,
   zero-total days, and biggest-band-at-bottom ordering.
6. `usageCsv.ts` — `buildUsageCsv(days)` returning rows with columns exactly:
   `date, cost_usd, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
   total_tokens, cache_hit_pct, num_models, top_model`. `num_models` = distinct models with
   nonzero tokens that day; `top_model` = highest total-token model that day, shortened via
   `prettyModel`; `cache_hit_pct = cache_read / (input + cache_read + cache_write)` to 1
   decimal. Tests cover field escaping, an empty day, and the pct rounding.

Write each test file first and watch it fail, then implement. Run the red phase **early** —
never after the final gate — and keep the failure output from landing verbatim in the
transcript (see the standards block below).

## Stage 3 — the view

Rewrite `src/renderer/components/tabs/HistoryDashboard.tsx` as a thin conductor with
subcomponents under `src/renderer/components/tabs/history/analytics/`. Keep each file small:

- `ControlBar.tsx` — sticky within the pane. Measure segmented control (In tokens, Out tokens,
  Total tokens, Prompts, Sessions, Time (activeMinutes), Spend) + range segmented control
  (30d / 60d / 90d / All time), an `N / M projects` indicator, from→to dates, a **Refresh**
  button that re-invokes the IPC only (never a scan), and an **Export CSV** button that builds
  the CSV client-side from the already-loaded payload for the CURRENT facet+range (no IPC),
  downloaded via Blob + anchor as `usage-history-<from>-<to>.csv`. Measure and range persist
  to `localStorage` under `sm.history.analytics.*`.
- `Headline.tsx` — big value for the active measure; delta vs the prior equal-length window
  (green/red, **inverted for Spend** where down=good; hidden with "no prior window to compare"
  when the prior window is incomplete); substats per-active-day / per-session / active-days /
  projects-touched; area sparkline of the daily series.
- `BudgetStrip.tsx` — port the existing monthly budget behavior (month-to-date, run-rate
  projection, cap input, over-cap warning) as a slim panel under the headline, fed
  month-to-date from the same dashboard payload (Spend over the current calendar month).
  **Reuse the existing localStorage/config key exactly** — read it out of the old file first.
- `ProjectFacet.tsx` — chips; click toggles a project in/out of **every** panel's computation,
  shift-click isolates, "show all (N)" resets. All faceting flows through `facetSlice`.
- `StackedTrend.tsx` — SVG stacked area by project (biggest band at bottom), absolute/share
  toggle, click a band to select that project and dim the rest, y-axis gridlines + formatted
  tick labels, x labels thinned to ~8. Band geometry comes from `stackedBands.ts`; colors from
  `projectColor.ts`.
- `Ranking.tsx` — table sorted by the active measure: dot + name, share bar, value, share %,
  trend delta, sessions, top tool. Row click selects a project.
- `ProjectDrill.tsx` — card below the ranking: 6 stats + model-mix list + tool-mix bars +
  a clear button. Selection clears when the selected project is faceted out.
- `panels/ModelMix.tsx` (share bar + list, names via `prettyModel.ts`),
  `panels/Concentration.tsx` (top-3 share + distribution bar + long-tail note),
  `panels/CachePanel.tsx` (donut hit-rate + reused tokens **plus** a cache-write line —
  `cacheCreationTokens` for the range, labeled "written to cache"),
  `panels/Rhythm.tsx` (7-bar weekday with peak highlight + weekend share).

States: skeleton while the IPC resolves; on failure `toast.error(...)` **and** retain the last
good data; an explicit empty state when the rollup has no rows in range.

Visual language — CORRECTION (an earlier draft wrongly said "dark idiom"): this app's
Tailwind tokens ARE the design's Almanac paper palette — `tailwind.config.js` maps
`bg → #f6efe1` (paper), `accent → #b85c34` (terracotta), `font-sans → Geist`,
`font-serif → Newsreader`, `font-mono → IBM Plex Mono`. So match the design's CSS as CLOSELY
as possible using the standard repo classes, and port its full typographic hierarchy too:

- Serif display type: the page h1 ("Where your Claude time goes" style header with italic
  accent em) and each SectionHead title use `font-serif` (Newsreader), sizes ~42/25px,
  negative letter-spacing; kickers ("01 · over time") are uppercase mono 10.5px in accent.
- Numerals are mono everywhere (headline 52px mono, substats 17px mono, table values).
- Cards: `borderRadius 14`, card background (`bg-elev`/card token = #fbf6ec), 1px edge
  border — mirror the design's `cardBase`.
- Sticky control bar: translucent paper `rgba(246,239,225,0.93)` + `backdrop-filter: blur(8px)`
  + bottom edge border, exactly as the design's control bar.
- Delta colors: positive/negative use the design's A_SAGE `#566b34` / A_ALERT `#a3441f`
  (inverted for Spend); dimmed stacked bands use A_MUTEBAND `#ded2bd`.
- Segmented controls (`Seg`): pill group on panel background, inset edge shadow, active
  segment on card background with soft shadow — copy the design's paddings/font sizes.
- Facet chips, ranking share bars, Concentration/ModelMix distribution bars, CachePanel
  donut (r=30, stroke 9, sage), Rhythm bars (#cfc0a2 with accent peak): match the design's
  dimensions and styling values, not approximations.

ETL completeness — the renderer view-model must reproduce EVERY derived quantity the design's
`A_SLICE`/`A_FACET` compute (variants/analytics-data.jsx), from the rollup IPC payload:
per-key totals + prevTotals + deltas; per-project rows with per-day series, daysActive,
lastActive (days since last active, null if idle in range), top-4 tool list, per-key delta;
byModel rescaled to the range and to the facet; activeDays; from/to; weekday (dow) aggregate;
cache `{readTok, hitPct, savedUsd}` where savedUsd uses the blended-price formula
(readTok/1e6 × (blended input price − blended cache price), blend weighted by model share);
and month-to-date spend for the preserved budget strip. Facet recompute follows A_FACET
exactly (totals/deltas/days recompute, model-mix rescale by cost share, active-day recount).
Where a quantity needs data the rollup lacks, derive the closest faithful equivalent from
what PRD 659's payload provides and note the substitution in a code comment — do not
silently drop a panel or stat.

`History.tsx`'s outer tab/sub-view routing stays; its old from/to/project-filter toolbar is
superseded by the in-pane control bar and should be simplified accordingly.
`SessionLog.tsx` is untouched.

## Stage 4 — gate and commit

Run the acceptance gate **last**, and let nothing error after it:

```bash
timeout 300 npm run typecheck
timeout 420 npm run test:unit
```

Do **not** run the e2e suite. Then commit, then emit the verdict sentinel as the literal last
line.

# Verification

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npm run typecheck
timeout 420 npm run test:unit
# duplicate-PRD guard — negative assertion, must exit 0 when clean:
if ls /home/bilko/.claude/session-manager/scheduled-plans/prds/66[5-8]-history-analytics-*.md >/dev/null 2>&1; then
  echo "HALT: duplicate PRDs 665-668 still queued"; exit 1
fi
echo "duplicate-PRD check clean"
# deliverable guard — this run must have produced a diff:
if git diff --quiet HEAD~1 HEAD -- src/renderer; then
  echo "HALT: no renderer diff in the commit — this run shipped nothing"; exit 1
fi
echo "renderer diff present"
```

# Acceptance criteria

- [ ] No `Skill` / `/develop` / `/process-feedback` / `ScheduleWakeup` / `scheduler_create_prd`
      invocation occurs anywhere in this run. The run produces a committed code diff.
- [ ] PRDs `665-history-analytics-lib`, `666-history-analytics-shell`,
      `667-history-analytics-trend-ranking`, `668-history-analytics-composition` are moved out
      of `scheduled-plans/prds/` into `scheduled-plans/prds-archived/`.
- [ ] `src/renderer/components/tabs/HistoryDashboard.tsx` is rewritten as the Usage Analytics
      view with subcomponents under `src/renderer/components/tabs/history/analytics/`.
      `SessionLog.tsx` untouched; `History.tsx` keeps its routing.
- [ ] Control bar: measure (In/Out/Total tokens, Prompts, Sessions, Time, Spend) + range
      (30d/60d/90d/All) segmented controls, `N / M projects` indicator, from→to dates, Refresh
      (IPC only, never a scan), Export CSV. Selection persists under `sm.history.analytics.*`.
      Token-measure definitions stated once in a code comment in the view-model.
- [ ] Project facet chips: click toggles, shift-click isolates, "show all (N)" resets; every
      panel recomputes client-side via `facetSlice`.
- [ ] Headline band with delta vs the prior equal-length window (inverted coloring for Spend,
      hidden when the prior window is incomplete), the four substats, and an area sparkline.
- [ ] Stacked trend: SVG stacked area by project, absolute/share toggle, click-to-select with
      dimming, gridlines + formatted ticks, ~8 x labels, colors from the shared
      `projectColor.ts` hash (extracted out of `sched-primitives.tsx`, one copy only).
- [ ] Ranking table with the seven columns + `ProjectDrill` card; selection clears when the
      project is faceted out.
- [ ] Composition row: ModelMix, Concentration, CachePanel (donut hit-rate + reused tokens +
      a "written to cache" `cacheCreationTokens` line), Rhythm.
- [ ] CSV export built client-side from the loaded payload with the exact ten columns, one row
      per day, downloaded as `usage-history-<from>-<to>.csv`.
- [ ] Monthly budget strip preserved as a slim panel under the headline, using the **existing**
      storage key.
- [ ] Loading skeleton, `toast.error` + retained last data on failure, explicit empty state.
- [ ] Unit tests exist and pass for `analyticsFormat`, `historyFacet.facetSlice`,
      `stackedBands`, and `buildUsageCsv`; written red-first.
- [ ] `timeout 300 npm run typecheck` and `timeout 420 npm run test:unit` both pass. The e2e
      suite is not run.
- [ ] Work is committed and the run ends with a truthful `SCHEDULER_VERDICT: PASS`.

# Out of scope

SessionLog / session list / resume actions. Removal of the old `history:aggregate` IPC.
Share features. Per-hour charts. A light-theme variant. Any e2e test run.

## Engineering standards

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
