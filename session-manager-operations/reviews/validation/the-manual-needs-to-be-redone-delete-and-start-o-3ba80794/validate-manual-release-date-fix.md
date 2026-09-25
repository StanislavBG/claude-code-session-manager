# Validation: manual-release-date-tz-fix

Epic: `the-manual-needs-to-be-redone-delete-and-start-o-3ba80794`
Plan: `pl-muhle9xz-5b4d78` — single PRD `1448-manual-release-date-tz-fix`
PRD file: `~/Projects/session-manager/session-manager-operations/scheduler/epics/the-manual-needs-to-be-redone-delete-and-start-o-3ba80794/prds-archived/1448-manual-release-date-tz-fix.md`
(Not present in this job worktree or the epic's own worktree — both only carry committed/disclosed
paths, and this repo's convention never commits `scheduler/epics/**/prds*` to git. Located directly
in the MAIN checkout, which is where `scheduler_create_prd` wrote it and where it still lives,
terminal, in `prds-archived/`.)

Landed commits: `53c9e7b5` (session-manager, docs-only record) + Bilko `09c7244` (the actual fix,
merged to Bilko `main` and pushed as `94635fd..09c7244`).

## PRD 1448-manual-release-date-tz-fix — VERIFIED

| AC | Evidence |
| --- | --- |
| `shared/manual-catalog.ts` exports `formatManualReleaseDate` | `~/Projects/Bilko` `git show 09c7244 -- shared/manual-catalog.ts`: adds `export function formatManualReleaseDate(isoDate: string): string { return new Date(isoDate).toLocaleDateString(undefined, { timeZone: 'UTC' }); }` with a one-line doc comment above it. |
| `ManualPage.tsx` (~line 194) uses it; no other unshifted call site | `git show 09c7244 -- src/pages/ManualPage.tsx`: line 194 now reads `` released {formatManualReleaseDate(toc.releasedAt)} ``. Re-ran `grep -rn "new Date(.*releasedAt" src server` in `~/Projects/Bilko` at current HEAD — 0 matches. |
| `tests/manual.test.ts` gains the TZ test | `git show 09c7244 -- tests/manual.test.ts`: new `it('formats the release date without a local-timezone day shift', ...)` asserting `formatManualReleaseDate('2026-09-25')` contains `'25'` and not `'24'`. |
| Bilko worktree `manual-date-fix` branch → merged to main, ff-only rules, worktree/branch removed | `~/Projects/Bilko`: `git branch --list manual-date-fix` → empty. `git worktree list` → no `manual-date-fix` entry. `git merge-base --is-ancestor 09c7244 main` → true (fast-forwarded, matches `RELEASE-2.0.0.md`'s recorded merge). `git status --short` on Bilko main shows only pre-existing, unrelated dirty state (`public/outdoor-hours/*`, prompt-session runtime files, scheduler `.reserved-*` markers, `<path>` sqlite-MCP artifact) — nothing from this PRD is uncommitted. |
| Deploy verified live, result + push SHA recorded | `git fetch origin main && git merge-base --is-ancestor 09c7244 origin/main` → true (pushed, `94635fd..09c7244`). Live check via Playwright (`https://bilko.run/products/session-manager/manual`, snapshot ref=e46): `"v2.0.0 · released 9/25/2026 · documents Session Manager v0.97.0"`. Served bundle is `/assets/index-BwMuAhBn.js`, matching the hash the PRD's own report recorded post-deploy. `~/Projects/session-manager/session-manager-operations/manual/RELEASE-2.0.0.md:130-155` carries the write-up and push SHA, committed as `53c9e7b5`. |
| Gate: `cd ~/Projects/Bilko && TZ=America/Los_Angeles timeout 300 npx vitest run tests/manual.test.ts` | Re-ran verbatim: `Test Files 1 passed (1)`, `Tests 11 passed (11)`. |

## Combined diff review

Full change-set for this plan is 3 files in `~/Projects/Bilko` (commit `09c7244`):
`shared/manual-catalog.ts` (+5), `src/pages/ManualPage.tsx` (+4/-2), `tests/manual.test.ts` (+11/-1).
No other file touched, on either repo (session-manager's own `53c9e7b5` is a 27-line append to
`RELEASE-2.0.0.md` only). `/code-review` and `/security-review` operate on this job's own
session-manager working tree, not the cross-repo Bilko diff, so self-reviewed the Bilko diff
directly: `formatManualReleaseDate` is a pure function (no I/O, no user input, no string
interpolation into HTML/SQL/shell), its one call site is a straight swap, and the grep re-run
above confirms no duplicate/leftover unshifted formatting call site was left behind. No
injection, secrets, or path-traversal surface. No findings.

## Findings

None — Critical / Important / Minor: empty.

VALIDATION: manual-release-date-tz-fix VERIFIED
