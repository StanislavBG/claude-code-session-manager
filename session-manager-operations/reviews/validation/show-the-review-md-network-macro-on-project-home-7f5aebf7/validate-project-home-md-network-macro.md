# Validation: show-the-review-md-network-macro-on-project-home (PRDs 2712-2717)

Base: 45e8cf55faaba3cadf6da87a373e6354d3e690f1. PRD files found in `prds-archived/`. Scoped gates for all six PRDs re-run together: 9 files, 313 tests green; `npm run typecheck` and `npm run lint` exit 0. (`/code-review` and `/security-review` not run separately; combined diff self-reviewed.)

## project-home-custom-macro-strip (2712) — VERIFIED
- `ProjectPagesSection.tsx` HotKeyStrip: container `project-home-hotkeys`, buttons `project-home-hotkey` with `data-macro-id`; returns null when no macros (l.~242-248); rendered in the header row so it shows on both pages (l.~433-436).
- No-input click -> `onLaunch(m)`; inputs -> `MacroInputsForm`, submit -> `onLaunch(m, undefined, values)`, cancel -> `setPending(null)`. `LaunchFn` type matches. `disabled={launching !== null}`, 'Starting…' on the pressed one.
- `PAGE_MACRO_IDS` filter excludes both builtins; page `MacroButton` code path untouched by the diff (only the `onLaunch` type and the wrapper `items-start` changed). Tests added (62 lines) and green.

## project-home-macros-launch-like-hot-keys (2713) — VERIFIED
- `useMacroLaunch(onSelect, personas)`, no opts; `grep resumeActive|requireReadiness src/renderer` -> none.
- Readiness check wrapped in `if (macro.job)`; persona-missing block uses `personas.length > 0 || !!macro.job`.
- Job-less path always calls `launchSession` (title/agent/tag/macroId/goal) then `onSelect(epicId)`; `findActive` is used only inside the `macro.job` branch, so a job-less macro cannot resume an unrelated active Epic. `ProjectHome.tsx:39` calls `useMacroLaunch(navigateToEpic, personas)`. Tests updated and green.

## macro-editor-surface-choice (2714) — VERIFIED
- `MacroEditor.tsx`: `macro-surface` select (Sessions / Project Home), state prefilled from `macro?.surface ?? 'sessions'`, hidden when `macro?.builtin`; payload spreads `surface` only for non-builtins.
- `SessionActionsBar.tsx`: `hotkey-manage-surface` chip only when `m.surface === 'project-home'`.
- `macroLibrary.cjs` saveMacro throws 'built-in macro surface cannot be changed' on a differing surface; same/absent surface passes. Tests green.
- Built-ins keep rendering as page buttons: `ProjectHome.tsx:37` uses `macrosForProject(..., 'project-home')`; builtin ids are routed to the existing `MacroButton`, selects unchanged.

## macro-save-route-surface-all-projects (2715) — VERIFIED
- `macroAdminRoutes.cjs`: `surface` passed to schema; create defaults sessions / `[cwd]`; `projects` other than exactly `["*"]` -> 400; update uses `macroVisibleIn`; all-projects saves run `verifyAllProjectsRequest` in fail-closed order (quote, origin id, ledger match, `quoteNamesEveryProject`) before any write; audit `admin_macro_save` + single `onChanged` after success only; `builtin-` still refused. `quoteNamesEveryProject` exported. Tests (119 lines) green.

## macro-save-mcp-surface-all-projects (2716) — VERIFIED
- `scheduler-mcp-server.cjs`: schema has surface enum, projects array, humanRequestQuote; handler forwards each plus `originClaudeSessionId: SM_CHAT_SESSION_ID`; `humanSessionRefusal` shared with unchanged `macro_delete` text; `projects` refused in job / no-chat-session; `ok:false` -> errorResult. Catalog entry updated. Tests green.

## md-network-skill (2717) — VERIFIED
- `SKILL.md` exists (60 lines, name `maintaining-md-network`, third-person description); no `src/` / `scripts/` references (grep clean).
- Skillset test pins four skills with explanatory comment; `plugin.json` 0.2.4 -> 0.3.0; `plugins/CLAUDE.md` and `seedDevPlugin.cjs` say 4 skills. Skillset test green, lint green.

## Full suite (`timeout 900 npm run test:unit`, SM_* unset): 7 files / 10 tests red on first run
Second full run showed a partly different set (flaky/load-sensitive). Seen red across the two runs: `page-surface.test.cjs` (agents.savePersona), `scheduler-resume-recovery-saturated`, `apiSurface.test.cjs`, `McpPlaceholders`, `McpServers.description`, `PluginHomePage`, `TelemetryNotice`, `remoteApi`, plus an unhandled rejection `config.ts:75 null.raw` from `Home.layout.test.tsx`. None of these touch this plan's PRDs' files.

## Findings
### Critical
- none
### Important
- `src/preload/__tests__/apiSurface.test.cjs:68` red: preload methods missing from table, including `macros.removeFromProject` (from the sibling 2670 delete-scope work in `SessionActionsBar.tsx`/`MacroEditor.tsx`, which merged inside this plan's range) plus `claudeConfig.*`, `config.canWrite`, `voice.*Tts*`, `plugins.list` from other plans. Needs the apiSurface table updated. Per-PRD gates missed it.
- Config-store/other-plan reds (`McpPlaceholders`, `McpServers.description`, `PluginHomePage`, `TelemetryNotice`, `page-surface` agents.savePersona, `config.ts:75` unhandled rejection) trace to the claudeConfig/app-settings plans, not this one; they still leave the combined tree red.
### Minor
- `scheduler-resume-recovery-saturated` and `remoteApi` hydrate look load/timing sensitive (passed in the first or second run only).
- `MacroEditor.tsx` / `SessionActionsBar.tsx` carry the sibling "Delete everywhere"/"Remove from this project" change (foreign to these six PRDs); noted, kept intact.
