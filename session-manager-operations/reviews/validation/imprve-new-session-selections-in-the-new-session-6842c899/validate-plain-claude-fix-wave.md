# Validation: plain-claude fix wave

Base: 2a8848f5. Final commit: HEAD at validation time (fix commits 7860b92d, f2d04dd0, 6b512c19; terminal PRD landed in d8553497).
All SM_* env unset. Foreign WIP (project-pages/home.html) untouched and unrelated.

## effective-model-hook-tolerates-missing-agents-api — VERIFIED
- Missing API → null: `src/renderer/lib/effectiveModelInfo.ts` ~L113 reads `window.api?.agents?.resolveModelInfo`, returns if not a function (hook state already null via setMainHalf(null)).
- Sync throw routed: `Promise.resolve().then(() => window.api.agents.resolveModelInfo(args)).then(ok, fail)`; fail → setMainHalf(null).
- API present unchanged: args `{cwd, agentType}` / `{cwd}`; cancelled flag and deps untouched (diff 7860b92d).
- New tests (missing namespace; sync throw) in effectiveModelInfo.test.ts.
- The six listed test files are unedited in the diff and pass.
- Gate: 5 files/43 tests pass; 3 files/24 tests pass; typecheck exit 0; lint exit 0.

## epic-worktree-ui-test-no-agent-chip — VERIFIED
- EpicWorktreeUI.test.tsx ~L149: renamed; asserts meta line non-null, contains "No agent", no `sm-epic/`, no merge button/text.
- Only that test file changed (f2d04dd0).
- Gate: 4 tests pass.

## dev-plugin-marketplace-version-0-2-4 — VERIFIED
- `.claude-plugin/marketplace.json` plugin entry version 0.2.4; one-line diff, top-level 0.1.0 untouched (6b512c19).
- Gate: dev-plugin-skillset.test.cjs 3 tests pass.

## terminal-launch-disables-dev-plugin-when-loop-off — VERIFIED
- `src/renderer/lib/epicLaunchCommand.ts` exports buildEpicClaudeCommand; L9 `DEV_PLUGIN_ENABLED_KEY`, L7 comment naming main twin ENABLED_KEY; L25 appends ` --settings ` + shellQuote(JSON) for loop-off.
- EpicTerminalPane.tsx L7 imports builder, L73 primitive selector for developLoop, L142 sole command build; no local shellQuote/modelFlag copies (grep clean).
- Tests present; gate: 3 files/21 tests pass; typecheck exit 0; lint exit 0. The earlier REFUTED cause (red EpicDetail.terminalMode via missing agents API) is fixed by 7860b92d.

## Final-commit full runs
- `npm run test:unit`: 897 files passed, 8499 passed, 1 skipped, 0 failed (Base: 30 failures in 8 files).
- `npm run typecheck`: exit 0. `npm run lint`: exit 0 (e2e budget 18/19).

## Findings
- Critical: none. Important: none.
- Minor: effectiveModelInfo.ts ~L113 reads the function for the type guard, then re-reads `window.api.agents.resolveModelInfo` inside the thunk; harmless but redundant (could call `resolveFn`).
- Review done by self-review (diff small; no input handling, secrets or path concerns).
