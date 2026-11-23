# Engineering standards

> Single source of truth for the engineering rationale behind every scheduled PRD.
> `scheduler_create_prd` appends a one-line pointer to this file's
> absolute path to every PRD — never a copy — and the executor's ordered run contract lives in
> the `dev-lead` persona it is launched as. Read a section here when a contract line needs its
> reasoning; edit here once and every PRD sees it.

## Performance

- State the time and space complexity of any non-trivial algorithm in a comment.
- Flag any nested loop over user-scaled data as a complexity hazard.

## Debugging approach

- Never attempt a fix until you can reproduce the bug on demand; if you can't, instrument the
  system until you can.
- Capture the reproduction as a failing test before changing production code.
- For a recent regression, bisect commits; record the steps in your report.

## API reuse and single source of truth

- One concept = one implementation. Before writing code that computes, fetches, formats or displays a value, search for the existing implementation and reuse it; a datum shown in N places flows from one shared accessor, store, hook or endpoint.
- Extend, don't fork: generalize a close-but-insufficient function (add a param, widen the contract) instead of cloning a variant. Why: copies drift, and divergence is how silent inconsistencies ship (one site reads a 0–100 percentage as a 0–1 fraction).
- Duplication you touch is a bug in scope: route both copies through the shared unit when both are in the PRD's `# Files`; otherwise name the duplicate in your report.

## Test-driven development

- Write the failing test first, then the implementation that makes it pass — for every feature and every bugfix.
- A bugfix starts with a test that reproduces the bug (red), then the fix (green).
- Do not write production code without a test asserting the behavior it adds.
- (Interactive sessions: if a `test-driven-development` skill is installed, it has the full
  red-green-refactor workflow. Headless PRD runs can't load it — the three rules above are the core.)
- Put the red test in the nearest existing scenario test for that workflow.
- Create a new test file only for a new module or a new workflow.
- Name tests and files by behaviour, never by PRD id.
- Never assert on production source text; a static invariant is a `scripts/check-*.cjs` lint.
- Full rubric (what is bloat, how to delete safely): the `## Test value — good test vs bloat` section of `tests/README.md`.

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

Long hangs, not bad code, cause most failed runs. The PRD body carries a one-line pointer to this file, never a copy. The dev-lead persona and the scheduler's finish protocol carry the per-run rules; this file gives the reasons behind them. Run order: orient → red → build → finish protocol (review → verify the `# Gate` commands → commit exact paths → verdict line).

- **Bound every command.** Wrap every test, build, dev-server, deploy, or poll command in a hard timeout, e.g. `timeout 300 <typecheck|unit>` or `curl --max-time 15`. Why: a bare `playwright test`, `vite`, `pnpm dev`, full e2e suite, or endpoint-polling publish hangs until the 4-hour watchdog kills it with SIGTERM.
- **Verify before done.** Run the acceptance test once before declaring success. Why: a run that ends on a failing test is not done — fix it or `exit 1` with the failure instead.
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`. Do not swallow it with `|| true` or retry silently. Exception: a `rateLimited` exit-1 is the scheduler's own benign auto-pause — it resumes next window on its own, so do not engineer around it.
- **Stay in the AC.** Do not add work past the acceptance checklist — "while we're here" extras are how runs overrun. Keep the body clean UTF-8, with no NUL or control bytes.
- **You ARE the executor — never re-queue or self-schedule.** Do the acceptance criteria yourself. Why: `/develop` or any queue-authoring skill just writes a *new* PRD and returns — the run exits 0 having done nothing, with no commit and no verdict line (`needs_review` with `no_verdict_sentinel`). The same applies to calling `ScheduleWakeup`, or backgrounding a review agent (`/code-review`, `/security-review`) and ending your turn with something like "I'll wait for the review agents to complete": a headless run has no next turn, so nothing ever resumes it — no verdict line prints, and the job parks in `needs_review` even though the work already landed. Run a required second review pass synchronously, inline, before the finish protocol — call the reviewer and read its result in the same turn. If the work is too big for one run, do not queue more work; see the timeout rule below. (Model mitigation MM-1 in [model-mitigations.md](../../../../session-manager-operations/architecture/model-mitigations.md).)
- **Never `git stash`, `git reset`, `git checkout -- <path>`, or `git clean` against working-tree state you did not create.** You are normally isolated in your own `git worktree` on branch `sm-job/<slug>`, and the scheduler salvages any uncommitted diff of yours on teardown — so you never need to touch shared state to protect your own work. Confirm isolation with `git rev-parse --git-common-dir` (a worktree's common-dir differs from its own `.git`) or by checking your cwd; `git diff`/`git status` are always safe. If you land in a SHARED tree with pre-existing dirty tracked files anyway, work around them — scope `git add`/commits to only the paths you touched — or end with `SCHEDULER_VERDICT: FAIL <reason>` (`SCHEDULER_VERDICT: BLOCKED_BY_FOREIGN_WIP` only when your gate failed on those files, as the finish protocol says); never discard, stash, or revert someone else's uncommitted changes to get a clean checkout. A shared tree may be feeding a running service that reads its config straight from the working tree, so reverting it is a production change, not a local inconvenience. The scheduler runs a shared-tree stash guard as a backstop (`checkSharedTreeGuard`/`evaluateSharedTreeGuard`), but that guard exists to catch a mistake, not to license one. Executors have stashed a sibling job's WIP and an operator's live config edit and never restored either.
- **`gh pr edit --body` can fail on repos with legacy GitHub Projects (classic) boards.** It queries the deprecated `repository.pullRequest.projectCards` field and errors with a `GraphQL: Projects (classic) is being deprecated` message even though the edit itself would otherwise succeed — a known `gh` CLI quirk, not a defect in your work. Prefer `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body="$(cat body.md)"` instead; it skips that field. If `gh pr edit` fails this way anyway retry immediately with the `gh api` form and note the fallback in your report.
- **Never `sleep N && <cmd>` to poll remote CI/job status.** The harness hard-blocks a `sleep` chained to another command. Use the tool's own blocking watcher under a hard cap instead: `timeout 600 gh run watch <run-id> --repo <owner>/<repo> --exit-status`.  `gh pr checks` exits 8 while checks are pending and 1 on failure — that is not a defect in your work.
- **The verdict line is your authoritative "I passed" signal — emit it truthfully.** The scheduler's finish protocol ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). `PASS` plus a landed commit is authoritative: it overrides incidental transcript markers, so a deliberately reproduced red test or a grep result containing "Error" will not false-trip `needs_review`, as long as the run genuinely ends green and committed. An artifact-only PRD (`deliverable: artifact` + `artifactPaths`) commits nothing by design: a green gate with a clean tree is a `PASS`, never a `FAIL` for the missing commit. Exiting 0 with uncommitted changes, or with no verdict line at all, is the #1 cause of needless `needs_review`. Never print `PASS` when the gate is red — that turns a safety net into a silent-failure machine.
- **If your own AC gate failed on a SIBLING job's in-flight file, say so with the right verdict — don't print a lying FAIL.** If the prompt disclosed a `--- FOREIGN WORKING-TREE STATE ---` section and your gate failure is confined to paths that section named as not your work, print `SCHEDULER_VERDICT: BLOCKED_BY_FOREIGN_WIP` (and `exit 1`) plus a `FOREIGN_WIP_PATHS: <path1>, <path2>, ...` line naming exactly the failing paths. The scheduler validates every listed path against the manifest it disclosed to you — list a path it never named, or claim this verdict for your own regression, and it is rejected back to `FAIL`. This is not an escape hatch: it exists so a correctly-diagnosed "not my regression" gets auto-requeued once the sibling clears its WIP, instead of spawning a fix-plan investigation into someone else's unfinished work.
