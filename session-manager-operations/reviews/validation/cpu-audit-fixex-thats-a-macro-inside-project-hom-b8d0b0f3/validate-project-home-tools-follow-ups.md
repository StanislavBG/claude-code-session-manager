# Validation: Project Home tools shared — follow-up wave

Base: 9d8170f3 (the 2947 commit itself, so its diff was read with `git show 9d8170f3`; later PRDs via `base..HEAD`).
PRD files found under `prds-archived/` (2947, 2948, 2949, 2952, 2953). Review tools: self-review (diff is small; no network/secret/path code added).

## hotkeys-panel-delete-every-project-macro — VERIFIED
- '*' row confirm text + `macros.delete({id})`: SessionActionsBar.tsx:63, :98 (`all ? 'Delete from every project?' : 'Remove from this project?'`).
- Project-scoped row unchanged: :67 `removeFromProject({id, cwd})`.
- Rejection toasts via existing catch (:53 area); panel stays open (no close on error).
- Built-in rows: Delete only rendered `!m.builtin && shown` (:111-113).
- Tests: SessionActionsBar.test.tsx 26/26 pass. Gate: vitest, typecheck, lint:hooks (OK), lint:selectors (OK) all exit 0.

## remove-project-home-builder-overlay — VERIFIED
- `.claude/agents/` holds only builder.md + page-*.md; overlay gone. `.gitignore` lines 16-19 keep `!.claude/agents/`, `.claude/agents/*`, `!.claude/agents/builder.md`, `!.claude/agents/page-*.md`; no project-home-builder line.
- Tracked files naming `agents/project-home-builder.md` outside reviews/: only `src/seed/agents/...` / `~/.claude/agents/...` references (package-files.test.cjs:38, promo research JSON, a pre-seed fixture in seedAgentPersonas.test.cjs) — none is the overlay path.
- Gate: seedAgentPersonas + personaMerge + package-files 58/58; lint:docs ok.

## macro-copy-every-project-tools — VERIFIED
- dataModelErd.ts:558 reads exactly the required summary.
- api.d.ts:350 comment keeps "absolute cwds or '*'" and adds the project-home => ['*'] clause; comment-only.
- Gate: dataModelErd test + typecheck pass.

## project-pages-section-footnote-spec — VERIFIED
- ProjectPagesSection.test.tsx:522 expects 'Every Project Home tool shows up here in every project'; ToolsPane.tsx unchanged since base; no remaining 'shows up in this list' in src/.
- Gate: ProjectPagesSection + ToolsPane specs pass (89 tests with dataModelErd).

## doc-macro-delete-every-project-tool — VERIFIED
- domain-model.md diff: macro_delete sentence adds the every-project refusal + 'Delete from every project?' / Delete everywhere; Project Home tool bullet adds the unforked-personas sentence without the removed path. Only those two bullets changed.
- Gate: lint:docs ok.

## Consent check — macroAdminRoutes.cjs saveHandler — HOLDS (no Critical)
Scenario: existing Project Home macro (projects ['*'], surface 'project-home'), body `surface:'sessions'`, quote naming only Project Home. Read: `resultSurface='sessions'` (:~163) so `projectHome=false`; `allProjects` is true because `existing.projects` includes '*'; `verifyAllProjectsRequest(body,{projectHome:false})` then requires `quoteNamesEveryProject`, and a Project-Home-only quote fails (:~72) → 400 before `saveMacro`, no write, no audit, no onChanged. A surface switch away from project-home therefore needs an every/all-projects quote.

## Full unit suite
`npm run test:unit`: 983/985 files, 9565 pass, 2 red: scheduler-load-gate-tick (lastDispatchAtByCwd yield) and timeoutShim (process group kill). Neither touches a file of this plan; both pass on isolated rerun (25/25) — load flakes, not caused by any PRD of this plan.

## Findings
- Critical: none.
- Important: none.
- Minor: SessionActionsBar.tsx:111-113 also hides Delete for rows not shown in this project (beyond the PRD's wording but matches its stated removeFromProject refusal; harmless).
- Minor: the two load-sensitive specs above can go red in a full parallel run.
