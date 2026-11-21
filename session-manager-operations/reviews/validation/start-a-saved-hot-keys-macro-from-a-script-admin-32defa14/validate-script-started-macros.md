# Validation: script-started macros (Base 6a5ab824)

Gates re-run: vitest on all 10 plan test files = 263 passed; `npm run typecheck` exit 0; `npm run lint` ok (e2e budget, scroll); `npm run lint:docs` ok; `wc -c CLAUDE.md` = 12000 (<= 12,000).
Note: the base..HEAD range also contains an unrelated stdio-guard plan (index.cjs boot guard, `3224-fix` PRD); not judged here.

## macro-script-start-flag — VERIFIED
- macroLibrary.cjs:170-171, 189-190 optional `scriptStart` on MacroSchema + MacroSaveSchema.
- saveMacro update :624-625 (true sets, false deletes, undefined keeps); create :648 (only true stored).
- macroAdminRoutes saveHandler unchanged field list; tests added in macroLibrary.test.cjs and macroAdminRoutes.test.cjs; gate green.

## macro-run-ipc-contract — VERIFIED
- ipcSchemas.cjs:1209-1214 strict schema as specified, exported at :1634; preload/index.cjs:573-574; api.d.ts `ChatExternalNewSessionResult`, payload fields requestId/via/effort, Macro + MacroSaveInput `scriptStart`. New schema test + typecheck green.

## chat-runner-awaited-new-session — VERIFIED
- chatRunner.cjs:1222-1262 startExternalNewSession (no-window immediate, randomUUID requestId, unref'd 30000 ms timeout), settleExternalNewSession (unknown id ignored), isTabBusy (inFlight/dispatching/pendingStart/waiting); handler registered :1340; exports :1382-1385. requestExternalNewSession unchanged. Tests + send-ack test green.

## renderer-script-new-session — VERIFIED
- launchSession.ts:30-31,53,94 origin passthrough only when set.
- remoteNewSession.ts:57-58: via 'script' → source `Script <agent>` and `origin: 'external'`; phone path unchanged; effort passed when non-empty; success report :53 / failure report :55 with toast+log retained. Tests green.

## macro-editor-script-start-toggle — VERIFIED
- MacroEditor.tsx:68 state from `macro?.scriptStart === true`; :148 `scriptStart` in the save payload; :376-388 checkbox `data-testid="macro-editor-script-start"`, label and hint text exact. Tests green; lint green.

## admin-macros-run-route — VERIFIED
- macroAdminRoutes.cjs runHandler: all listed 400 refusals present (builtin-, unknown, not visible, job, scriptStart!==true naming the checkbox, persona, inputs key/type/length/count, effort via PRD_EFFORT_LEVELS, render failure).
- Payload `{cwd, agentName, tag, title: label, prompt, macroId: macro.id, via:'script'}` (+effort). The renderer's launchSession records macroId into the Epic runtime/source (launchSession.ts:69) with producer 'new-epic-ui', which is what crossProjectFeedback.cjs:574 (verifyMacroAutoStart) requires, so a script start grants the same as a press.
- Dedupe (index + isTabBusy, 60 s recent map, in-progress map) → 200 alreadyRunning:true; 503 on failure, no audit; audit `admin_macro_run` on start. index.cjs wires deps; header documents curl. Real localAdminHttp no-Bearer test present; gate green.

## doc-script-started-macro-law — VERIFIED
- CLAUDE.md MACRO bullet states the script-start rule at 12000 bytes; domain-model.md gains the script-start paragraph + systemd line and the consent sentence in the auto-start paragraph; epicMint.cjs header comment only. lint:docs ok.

## Findings
### Critical
- none
### Important
- none
### Minor
- remoteNewSession.ts:55 reports `error: msg` unbounded, but the schema caps `error` at 500 chars (ipcSchemas.cjs:1213); a long error would be rejected and the route would fall to the 30 s timeout instead of launch-failed. Truncate to 500.
- macroAdminRoutes.cjs `recentRuns` map entries are only deleted on re-read of the same key; bounded by macro count, so negligible.
- domain-model.md systemd example uses unquoted `jq -nc {cwd:env.CWD}+{id:env.ID}`; the filter likely needs quoting to be copy-pasteable.
