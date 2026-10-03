# Validate: Scheduler shows one readable, parallel plan per goal

Base: `6e833690` (last commit before this plan). Plan HEAD at validation time: `3271278a`
(`merge scheduler job 1488-plan-card-goal-and-shape`), on the main checkout
`/home/bilko/Projects/session-manager` — PRDs 1484-1488 all carried `cwd:
/home/bilko/Projects/session-manager` in their frontmatter and landed directly there (no
per-job worktree), interleaved with unrelated jobs (1490, demo-video fixes, two release
bumps). Commits per PRD, found via `git log --oneline 6e833690..3271278a -- <paths>`:

- 1484: `20b5a65c` feat(renderer): add depSlugResolve helper for dependsOn slug matching
  (merge `9edeeb58`)
- 1485: `757ca1c2` docs(develop): write the plan-shape objective into /develop and PRD
  authoring guide (merge `172ab43d`)
- 1486: `0773ab66` fix(scheduler-ui): canonicalize dependsOn in
  buildPlans/summarizeQueue/SchedulePanel (merge `f8dbfa91`)
- 1487: `ebb0f4a7` feat(scheduler-ui): group plans by their validate PRD's dependsOn closure
  (merge `e0947160`)
- 1488: `d1da1e67` feat(scheduler-ui): render epicLabel/width on plan cards (merge `3271278a`)

## 1484-renderer-dep-slug-resolve — VERIFIED

- `src/renderer/lib/depSlugResolve.ts:12-14,21-25,38-64` — `bareSlug`, `resolveDepSlug`,
  `canonicalizeDependsOn` all present with exactly the signatures the AC asked for.
  `resolveDepSlug` mirrors `src/main/lib/depSlugResolve.cjs:17-29`'s rule verbatim (exact match
  first, else bare-name match). `canonicalizeDependsOn` builds one `Set<string>` of all slugs
  and one `Map<bareSlug, string[]>` up front (`depSlugResolve.ts:48-56`), then does a single
  pass over jobs/deps — O(jobs + deps), no nested scan. It returns the same object reference
  for a job whose `dependsOn` needed no rewrite (`return changed ? { ...job, dependsOn: next }
  : job`) and never mutates `deps` (builds a fresh `next` array via `.map`).
- `src/renderer/lib/__tests__/depSlugResolve.test.ts` — 14 cases covering every AC bullet
  (exact match, bare→prefixed, already-prefixed, unknown dep, ambiguous bare name, null/
  undefined/empty dependsOn, no-mutation, object-identity-preserved-when-unchanged).
- No other file under `src/` touched by this PRD's commit (`git show --stat 20b5a65c`
  confirms only the two new files).
- Gate re-run: `timeout 300 npx vitest run src/renderer/lib/__tests__/depSlugResolve.test.ts`
  → 14 passed. `timeout 300 npm run typecheck` → exit 0, no errors.

## 1485-develop-plan-objective-doc — VERIFIED

- `plugins/session-manager-dev/skills/develop/SKILL.md` — new `### Plan objective` section
  inserted directly before `### Steps` (diff hunk at old line 47), stating one-goal-per-
  validate-PRD, the validate title as card title (`Validate: <plain-language goal>`), wide-
  over-deep, and the same-goal follow-up rule — matching all four AC bullets.
  Step 10 reworded to `**Show the plan once**: the plan goal line, the stage view (...) and a
  table (...)`; the `### The validate PRD` item 1 gained "Its title is the plan goal shown on
  the Scheduler card, so write it as `Validate: <plain-language goal>`."
- `src/main/templates/PRD_AUTHORING.md:1` — stamp bumped `v4` → `v5`; the §5 `planId`
  paragraph gained the required sentence about the Scheduler grouping a plan card as a
  validate PRD plus its dependents.
- Line budget: `git show 6e833690:plugins/.../SKILL.md | wc -l` = 260, current file = 274 →
  +14 lines, within the "at most 20" cap. No other files changed in this PRD's commit.
- Gate re-run: `timeout 120 npm run lint:docs` → `doc-hierarchy: ok (26 junctions, 36 files
  linted)`, exit 0.

## 1486-scheduler-ui-canonical-deps — VERIFIED

- `src/renderer/lib/schedulerStages.ts:337-345` — `buildPlans` canonicalizes `jobs` into `cj`
  as its first statement after the empty-array guard, and every downstream read (`avgMs`,
  `bySlug`, `ready`/`aheadIdx`, `buildBacklogTree`) uses `cj`, not the raw `jobs` parameter.
- `schedulerStages.ts:553-556` — `summarizeQueue` canonicalizes into `cj` at its top; the
  `readyNow` loop and the nested `buildPlans(cj, ...)` call both use the canonical array.
- `src/renderer/components/SchedulePanel.tsx:234-236` — the `buildBacklogTree` memo wraps both
  `snap.jobs` and `rawSnap?.jobs` (when present) in `canonicalizeDependsOn`, still inside the
  existing `useMemo`, so no new array is allocated outside the memo (checked: the `.map()` call
  is on the same line as the `buildBacklogTree` call, inside the memo factory).
- `src/renderer/lib/__tests__/schedulerStages.test.ts` — new `describe('buildPlans
  canonicalizes bare-named dependsOn', ...)` with the exact `1-a,2-b,3-c,4-d,5-e` fixture from
  the AC (one plan, prdCount 5, stageCount 3, stage 2 has 3 rows), repeated with no `planId`
  (fallback path), plus `describe('summarizeQueue canonicalizes ...')` asserting `readyNow ===
  1` for a pending job whose bare dep is still pending.
- Gate re-run: `timeout 300 npx vitest run src/renderer/lib/__tests__/schedulerStages.test.ts
  src/renderer/components/tabs/scheduler/__tests__/ src/renderer/lib/backlogTree.test.ts` →
  16 files / 153 tests passed. `npm run typecheck` → exit 0. `npm run lint` → all 8 lint
  sub-checks OK.

## 1487-scheduler-ui-validate-defined-plans — VERIFIED

- `schedulerStages.ts:79-92` — `Plan` interface gained `epicLabel: string`, `validateSlug:
  string | null`, `width: number` exactly as specified.
- `schedulerStages.ts:259-328` — new `claimClosure` (iterative stack walk, marks `claimed`
  before pushing — cycle-safe, O(V+E)) and `sectionGroups` (validate rows sorted ascending by
  `byPriority`/PRD number via `schedulerStages.ts:166-170`, each claims itself + its transitive
  in-Epic `dependsOn` closure if not already claimed; leftover rows fall back to the existing
  `planGroups`). `stripValidatePrefix` strips a leading `Validate` + `:`/`-`/whitespace,
  case-insensitively.
- `schedulerStages.ts:358-401` — `buildPlans`'s per-section loop now iterates
  `sectionGroups(...)` instead of `planGroups(...)`; `epicLabel`/`label`/`validateSlug`/`width`
  are all computed and pushed per plan; the ` · plan i/N` suffix is now applied only to the
  subset of `sectionPlans` with `validateSlug === null`, and `N` is computed over that subset
  only (`schedulerStages.ts:514-522`).
- Tests added to `schedulerStages.test.ts`: (a) one validate PRD over three different
  `planId`s → one plan, prdCount 4, stageCount 2, width 3, label `Ship X`, validateSlug
  `4-validate-x`; (b) two validate PRDs (`5-validate-one`, `9-validate-two` via `8-y`) → two
  plans, every slug in exactly one plan, the earlier-numbered validate keeps the row it
  already claimed; (c) no-validate-rows Epic → same plan count/labels as the planId fallback,
  all `validateSlug === null`. All three pass.
- `grep -rn "stageCount:" src/renderer --include=*.ts --include=*.tsx | grep -v __tests__`
  returns only the `Plan` interface declaration itself — `buildPlans` is the only production
  constructor of a `Plan`, so the "update any other constructor" bullet is vacuously satisfied.
  `archivedPlanRows.ts` (listed under `# Files`) was not touched — not needed for this change,
  consistent with the PRD's own "if the work needs another file" carve-out.
- Gate re-run: same command as 1486's gate (all three gates share the same vitest invocation
  on this file) — 153/153 passed, typecheck clean, lint clean.

## 1488-plan-card-goal-and-shape — VERIFIED

- `src/renderer/components/tabs/scheduler/PlanBand.tsx:207-211` — `plan-label`'s `title`
  attribute is `${plan.label} — ${plan.epicLabel}` when they differ, else `plan.label`;
  truncation classes (`truncate shrink-0 max-w-[320px]`) unchanged.
- `PlanBand.tsx:216-225` — `plan-meta` renders `{project} · {epicLabel} · {N} PRD(s) · {width}
  wide · {S} stage(s)` when `validateSlug != null && epicLabel !== label`; otherwise the old
  text with ` · {width} wide` inserted only when `width > 1`. Exactly matches the AC's two
  branches.
- The old `plan-step-count` span (`N steps · D done`) is removed; `trackerStepParity.test.tsx`
  was updated to assert `plan-progress-label` (`6/6`) instead — the only existing-test change,
  and it is the one the AC explicitly permitted.
- New `src/renderer/components/tabs/scheduler/__tests__/PlanBandMeta.test.tsx` — case (a)
  validate-defined plan (`epicLabel 'My Epic'`, `prdCount 4`, `width 3`, `stageCount 2`) asserts
  meta text `p · My Epic · 4 PRDs · 3 wide · 2 stages` and label title `Ship X — My Epic`; case
  (b) `validateSlug: null`, `width: 1` asserts meta text has no "wide" substring. Both pass.
- Gate re-run: `timeout 300 npx vitest run
  src/renderer/components/tabs/scheduler/__tests__/` → part of the same 16-file/153-test run
  above (all scheduler `__tests__` files are in that glob), all green; typecheck and lint also
  clean (same runs as above).

## Combined-diff review

`git diff 6e833690..3271278a --stat` touches 10 files, +461/-27: `SKILL.md`,
`PRD_AUTHORING.md`, `SchedulePanel.tsx`, `PlanBand.tsx`, 4 test files, `depSlugResolve.ts`,
`schedulerStages.ts`. `/code-review` and `/security-review` are not runnable against this
diff from the validator's own job worktree (the diff lives on the main checkout
`/home/bilko/Projects/session-manager`'s branch, not in this worktree's tree), so this is a
manual self-review of the full diff:

- No new user input, file-path, or network boundary is introduced — all five PRDs touch only
  renderer-local pure functions, a React component's header markup, and two documentation
  files. No secrets, no `eval`/dynamic `require`, no path construction from untrusted input.
- `claimClosure` is a new directed-closure walk; it is not a duplicate of the existing
  `weakComponents` (undirected component detection) — the two serve different purposes
  (directed "what does this validate PRD depend on" vs. undirected "which rows form one
  connected wave"), so this is new logic, not reuse of something already present.
- `canonicalizeDependsOn` is called twice on the same array in one path
  (`summarizeQueue` canonicalizes into `cj`, then calls `buildPlans(cj, ...)`, which
  canonicalizes `cj` again). This is redundant work, not a correctness bug — the function is
  idempotent (already-exact slugs short-circuit on the `Set.has` check) and O(jobs+deps), and
  the hot path (`SchedulePanel`'s memo) does not hit this double call. Not worth flagging as a
  finding; noted for completeness only.

## End-to-end check (read-only, per PRD's Implementation notes)

Wrote a throwaway `src/renderer/lib/__scratch_1489_validate__.test.ts` (node env) in the main
checkout that read every record in
`/home/bilko/Projects/burrow/session-manager-operations/scheduler/state/history.jsonl`,
kept the last record per slug with a `status` for epicId
`x-and-linkedin-review-that-all-is-set-for-tonigh-4be78afa` (20 rows), and fed them straight
to `buildPlans(jobs, { sessions: {} })`. Ran via `npx vitest run
src/renderer/lib/__scratch_1489_validate__.test.ts`, output appended to
`/tmp/validate-1489-plan-check.txt` (vitest suppresses console):

```
jobCount: 20, planCount: 3
1. validateSlug 999-validate-pipeline-schedule-single-source — prdCount 15, width 3, stageCount 10
2. validateSlug null (fallback) — prdCount 1, width 1, stageCount 1
3. validateSlug 981-validate-x-linkedin-readiness — prdCount 4, width 3, stageCount 2
```

Matches the PRD's expectation ("before this plan it was 21 one-PRD, one-stage plans; expected
now: about 3 plans, the largest several PRDs wide") almost exactly: 3 plans, the largest 15
PRDs wide at width 3. (`epicLabel` printed as a truncated `Epic x-and-linked…` placeholder —
an artifact of passing `sessions: {}` to this standalone script, which has no real
`PromptSession` for the Epic to read a title from; not a defect in the shipped code, which
always has `sessions` populated from the live store.) The scratch file was deleted
(`rm src/renderer/lib/__scratch_1489_validate__.test.ts`) before this record was written; `git
status` in the main checkout is clean of it.

## Findings

None. All five PRDs' acceptance criteria are met in full, every PRD's own gate re-runs green,
and the end-to-end check on real production history data confirms the user-visible outcome
the plan was written to produce (one-PRD/one-stage plan cards collapsing into a handful of
wide, multi-stage plan cards per goal).
