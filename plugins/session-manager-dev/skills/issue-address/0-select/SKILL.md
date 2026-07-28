---
name: issue-address:select
description: Step 0 of issue-address — select exactly ONE open issue on the current project's repo to work, by orchestrating 4 nested sub-skills (fetch-pool, reject-fixed, reject-claimed, rank-impact) in sequence. Only invoked when the caller hasn't already named a specific issue number.
---

# issue-address:select (sub-orchestrator)

Only runs when `issue-address` is invoked without a specific issue number already named
(if the caller already has one, skip straight to `issue-address:confirm-open` — that step
re-verifies the single chosen issue right before work starts, as a freshness guard; this
skill's job is choosing which issue out of many, cheaply and verifiably, across the whole
pool).

Exists because of a real incident: issue #180 was picked by title/label alone, and 2 full
`issue-address` steps ran before discovering — only once `issue-address:reproduce`
actually tried to reproduce it — that the fix had already shipped a day before the issue
was even filed. The information needed to catch that (the issue's own cited file/line + a
grep of current code) was available for free at selection time and simply wasn't checked.

This skill is itself further decomposed into 4 nested sub-skills, for the same reason
`issue-address` is decomposed: so each check is independently invokable and its result
inspectable, instead of one opaque scan-and-pick pass. It also closes two gaps found after
the first version shipped: an unverified fetch limit (the same class of silent-truncation
bug that hit `pr-review-sweep`), and an unconfirmed PR-search false positive (seen live in
the #180 trial — a text search on "180" matched an unrelated PR by number coincidence).

**Naming convention:** sub-directories are prefixed `0-`, `1-`, `2-`, `3-` in execution
order (see `issue-address/SKILL.md` for the repo-wide rule) — a plain directory listing of
this folder sorts in DAG order without opening any file.

## Pipeline DAG

```
open-issue pool
      │
      ▼
┌─────────────────────────────┐
│ 0. select:fetch-pool         │  verified-complete fetch (no silent truncation)
└─────────────────────────────┘
      │ full pool w/ bodies, labels, assignees, comments, reactions
      ▼
┌─────────────────────────────┐
│ 1. select:reject-fixed       │  grep current code at each cited file/line
└─────────────────────────────┘
      │ survives (already-fixed candidates dropped, evidence logged)
      ▼
┌─────────────────────────────┐
│ 2. select:reject-claimed     │  PR-search hits confirmed, not trusted blind
└─────────────────────────────┘
      │ survives (PR'd/claimed/duplicate candidates dropped, evidence logged)
      ▼
┌─────────────────────────────┐
│ 3. select:rank-impact        │  composite score, not label text alone
└─────────────────────────────┘
      │
      ▼
one issue number + full audit trail (ranked list, rejected list, why)
      │
      ▼
issue-address:confirm-open  (next skill up the chain, outside this sub-orchestrator)
```

| Step | Input | Output | On failure/empty |
|---|---|---|---|
| 0. `select:fetch-pool` | none (repo-wide `gh issue list`) | full open-issue pool, verified-complete | n/a — loops its own fetch until verified complete |
| 1. `select:reject-fixed` | full pool | `already-fixed` list (w/ evidence) + `survives` list | if pool empties out here, report "no candidates, all already fixed" |
| 2. `select:reject-claimed` | `survives` from step 1 | `already-claimed` list (w/ evidence) + `survives` list | if pool empties out here, report "no candidates, all claimed/PR'd" |
| 3. `select:rank-impact` | `survives` from step 2 | one issue number + ranked list + justification | if `survives` was already empty, report the empty pool rather than fabricating a pick |

## Output

Hand off the single selected issue number to `issue-address:confirm-open`, which
re-verifies it fresh (state, PR/duplicate claims) immediately before work starts — this
skill's checks are about narrowing a big pool cheaply and verifiably; confirm-open's
checks are about not acting on stale information for the one issue actually chosen.
