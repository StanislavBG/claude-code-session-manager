# Validation: validator dependsOn plan (1416–1418)

Plan `pl-mug1dms4-eba939` / `pl-mug1dug5-cf3ae0`, epic
`develop-can-t-queue-its-mandatory-validate-prd-v-1186c72c`. PRD source files (untracked scheduler
state, never committed to git) read from
`/home/bilko/Projects/session-manager/session-manager-operations/scheduler/epics/develop-can-t-queue-its-mandatory-validate-prd-v-1186c72c/prds-archived/`.
Landed commits: `70b1efac` (1416), `05d9aa75` (1416 merge), `b39c868a` (1417), `54165e03` (1418).

## 1416 — plan-validator-transitive-dependson

**Verdict: VERIFIED**

| AC | Evidence |
| --- | --- |
| Transitive reachability (validator → sink → job) | `src/main/lib/planValidator.cjs:62-76` — BFS over `validator.dependsOn`, expanding via `rowsForSlug(slug).dependsOn` each iteration |
| Existing direct/non-pending/self/null cases still pass unchanged | `src/main/__tests__/planValidator.test.cjs:12-71` — the 6 pre-existing tests are untouched (diff only appends after line 71) |
| Cycle-safe (visited set) | `src/main/lib/planValidator.cjs:63,67-68` — `visited` Set checked/populated before recursion into a slug's deps |
| New tests: 2-hop, 3-hop, unrelated branch, cycle | `src/main/__tests__/planValidator.test.cjs:73-114` — four new tests present, one per case |
| Gate: `timeout 120 npx vitest run src/main/__tests__/planValidator.test.cjs` and `npm run typecheck` | Ran `timeout 300 npx vitest run src/main/__tests__/planValidator.test.cjs src/main/__tests__/ipcSchemas-dependsOn.test.cjs` → `Test Files 2 passed (2)`, `Tests 15 passed (15)`. `timeout 300 npm run typecheck` → exit 0, no output (both `tsc --noEmit` invocations clean) |

Implementation note beyond the AC list: the walk also reuses `depSlugResolve.cjs`'s `bareSlug`
matcher (`src/main/lib/planValidator.cjs:11,44-57`) and scopes by `job.cwd`
(`src/main/lib/planValidator.cjs:40-42`), covered by
`src/main/__tests__/planValidator.test.cjs:116-124` (cross-project bare-slug collision → false).
Not in the PRD's AC list verbatim but was explicit in the Implementation notes ("reuse whatever
matcher... scope... to job.cwd"), and the matching rule was checked directly against
`src/main/lib/depSlugResolve.cjs:27-31`'s `resolveDepSlug` (exact-then-bare) — same precedence.

## 1417 — raise-dependson-cap-to-100

**Verdict: VERIFIED**

| AC | Evidence |
| --- | --- |
| All three `.max(20)` → `.max(100)` via shared constant | `src/main/ipcSchemas.cjs:332` defines `MAX_DEPENDS_ON = 100`; used at `:357` (`schedulerCreatePrd`), `:424` (`scheduleSetPrdDisposition`), `:508` (`adminPrdFrontmatterPatch`) |
| `grep -rn 'max(20)' src/main/ipcSchemas.cjs` shows nothing | Ran it — no output (exit 1), confirmed no schema left at the old cap |
| Unit test: 36 entries accepted, 101 rejected | `src/main/__tests__/ipcSchemas-dependsOn.test.cjs:23-33` — both cases present (plus a bonus exactly-100-accepted case) |
| Docs stating the old 20 limit updated to 100 | Ran `grep -rn 'at most 20\|20 entries\|max 20\|cap.*20\|20.*cap' scripts/scheduler-mcp-server.cjs src/main/templates/PRD_AUTHORING.md plugins/` — all hits are unrelated (poll-loop iteration caps, feedback body-char cap, style-reference sample HTML), none reference the old `dependsOn` cap |
| `npm run typecheck` and the test file pass | Same run as above: `ipcSchemas-dependsOn.test.cjs` included in the 15/15 pass; `npm run typecheck` exit 0 |

`vitest.config.ts:23` also registers the new test file in the project's explicit include list (not
an AC line but required for the gate command itself to pick the file up) — confirmed present.

## 1418 — develop-skill-validator-large-plan-guidance

**Verdict: VERIFIED**

| AC | Evidence |
| --- | --- |
| Phase 1 states the 100-entry cap and the sink-PRD rule | `plugins/session-manager-dev/skills/develop/SKILL.md:207-210` |
| Phase 2 no longer claims a literal every-slug list without the sink caveat | `plugins/session-manager-dev/skills/develop/SKILL.md:459-462` |
| Fallback sentence mentions stale-running-app cause + restart onto ≥0.96.0 | `plugins/session-manager-dev/skills/develop/SKILL.md:220-224` |
| `npm run lint:docs` passes | Ran it → `doc-hierarchy: ok (27 junctions, 38 files linted)` |

Only one copy of the skill exists in the repo (`grep -rl "Every plan ends with one" --include=SKILL.md`
finds a single file), so the Implementation notes' "update elsewhere" contingency did not apply.

## Diff review

`git diff 67cd2bed..54165e03` (base commit before this plan, through the last PRD's commit) —
6 files, +175/-18: `src/main/lib/planValidator.cjs`, `src/main/__tests__/planValidator.test.cjs`,
`src/main/ipcSchemas.cjs`, `src/main/__tests__/ipcSchemas-dependsOn.test.cjs`, `vitest.config.ts`,
`plugins/session-manager-dev/skills/develop/SKILL.md`. Self-reviewed (`/code-review` and
`/security-review` are not in this persona's toolset — Read/Grep/Glob/Bash only — so this is a
manual pass, not the automated slash commands):

- No filesystem, network, shell, or dynamic-require calls introduced — `planValidator.cjs` stays a
  pure function over caller-supplied arrays; `ipcSchemas.cjs` change is a numeric constant plus its
  three call sites.
- Slug-matching logic (`rowsForSlug`/`matchesJob` in `planValidator.cjs`) cross-checked line-by-line
  against `depSlugResolve.cjs:27-31`'s `resolveDepSlug` — same exact-then-bare-match precedence, so
  the walk cannot diverge from the scheduler's own dependency gate on an ambiguous bare-slug hit.
- No secrets, no user-controlled strings reach a path or shell boundary — everything here is queue
  rows (already-validated `DepSlugSchema` strings) and static config.
- No duplication introduced: the cap is a single shared constant, not copy-pasted per schema; the
  BFS reuses the existing `bareSlug` helper rather than reimplementing it.

## Findings

None — Critical: none. Important: none. Minor: none.
