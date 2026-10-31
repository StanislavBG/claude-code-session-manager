# Validation: macro auto-start plan (Base e4163106)

Commits found per PRD via `git log e4163106..HEAD`. Full `npm run test:unit` (SM_* unset): 3 failed / 833 files, 7896 passed. `npm run typecheck`: clean. wc -c CLAUDE.md = 11994 (≤12000). `src/main/lib/feedback-remote/macroAdminRoutes.cjs` and `EpicApprovalBar` have zero diff vs base.

## macro-auto-start-targets-field — VERIFIED
macroLibrary.cjs MacroSchema/MacroSaveSchema `autoStartTargets` + `macroAllowsAutoStart`; omitted keeps, `[]` deletes (55e31411); macroLibrary tests cover round trip; promptSessionSchema `macroId` on source.

## macro-editor-auto-start-setting — REFUTED
MacroEditor.tsx now always sends `autoStartTargets: []` (Off) on save; existing `SessionActionsBar.test.tsx:147` (macro-save → `macros.save` args) now FAILS (Received has extra `"autoStartTargets": []`). Behavior is fine, but the plan left a red test.

## macro-press-stamps-epic — VERIFIED
launchSession.ts / useMacroLaunch.ts / promptSessions.ts stamp `source.macroId` (49cd96b8); tests updated and green.

## phone-press-stamps-epic — REFUTED
webRemote.cjs forwards `macroId` (22bc5538), but `tests/unit/webRemoteSessionCreate.spec.ts` "macro without inputs forwards the default lines" now FAILS (keys include `macroId`). Spec not updated.

## macro-ground-in-auto-start — VERIFIED
crossProjectFeedback.cjs `verifyMacroAutoStart`: sender Epic resolved only from `originClaudeSessionId` via resolveSourcePromptIdFromClaudeSession; `fromEpicId` is only stored on the source, never used to grant. Requires producer new-epic-ui + macroId, macro `macroAllowsAutoStart(toCwd)`, tag bug/feature, cap 5 (reserved/released on mint failure). Tests in crossProjectFeedback.test.cjs.

## feedback-tool-forwards-session — VERIFIED
scripts/scheduler-mcp-server.cjs: `delete payload.originClaudeSessionId` then set only from `process.env.SM_CHAT_SESSION_ID`; tests (schedulerMcpServerFeedback.test.cjs) cover forged id dropped / overridden. Green.

## quote-must-name-target — VERIFIED
`quoteNamesTarget(quote,toCwd)` checks the quote itself on non-alnum boundaries; verifyAutoStart uses it (4c8e31fd); tests added, green.

## renderer-accepts-macro-stamp — VERIFIED
inboundAutoApprove.ts accepts requestedBy 'macro'; EpicSource type union updated; epicOrigin.ts shows macro label; tests green.

## auto-started-session-full-aim — VERIFIED
inboundOpeningPrompt.ts composes AIM; `approveProposed(id, source, intake)` applies openingPrompt/sections; re-reads Epic and checks still-proposed before start. EpicApprovalBar: no diff vs base.

## auto-start-turn-never-asks — VERIFIED
chatRunner.cjs:1142-1148 chat:run handler destructures `origin` and passes it to `run(...)`→executeRun (line 523, used at 607 via `turnInstructionFor`). autoStartedSession.cjs supplies no-ask instruction; chatRunOrigin tests green.

## auto-start-follow-up-turn — VERIFIED
`shouldFollowUp(origin)` is true only for 'inbound-proposal'; the follow-up is sent with origin 'scheduler' so it cannot chain another (chatRunner.cjs:277,856; autoStartedSession.cjs autoStartFollowUp). Tests green.

## doc-macro-auto-start-law — REFUTED
CLAUDE.md 11994 bytes OK and domain-model/SKILL docs updated, but 6816a2e4 bumped `plugins/session-manager-dev/.claude-plugin/plugin.json` to 0.2.3 without updating `.claude-plugin/marketplace.json` (0.2.2): `scripts/__tests__/dev-plugin-skillset.test.cjs:59` FAILS.

## epic-source-keeps-auto-start-stamp — VERIFIED
promptSessionSchema.cjs EpicSourceSchema declares `proposal`/`autoApprove` as `z.unknown().optional()` (5c2b28a8); tests/unit/promptSessionSchema-crossBoundary.spec.ts asserts both survive `promptSessionsMergeActiveIndex` for human and macro, and malformed values keep the row. `isAutoStartedEpic` reads `source.autoApprove` truthy, so it stays true. (Inferred from schema test + code; no direct end-to-end test of isAutoStartedEpic after merge.)

## Cross-plan
- No agent-reachable path sets autoStartTargets: macroAdminRoutes.cjs unchanged; new test in macroAdminRoutes.test.cjs shows admin save ignores it on create and update. Green.
- Full test:unit NOT green: 3 failures listed above.

## Findings
- Important: `src/renderer/components/epics/__tests__/SessionActionsBar.test.tsx:147` stale vs MacroEditor save payload.
- Important: `tests/unit/webRemoteSessionCreate.spec.ts` stale vs webRemote macroId forwarding.
- Important: `.claude-plugin/marketplace.json:17` version 0.2.2 vs plugin.json 0.2.3.
- Minor: no end-to-end test that isAutoStartedEpic survives a merge save; macro grant counts are in-memory (reset on restart, documented).
