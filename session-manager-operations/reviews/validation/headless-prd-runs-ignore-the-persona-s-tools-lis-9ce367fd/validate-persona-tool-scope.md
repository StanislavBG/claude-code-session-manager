# Validation: persona tool scope (plan 9ce367fd)

Base: 6d1032aef8799ac69f218cc74a47eb97d8bf46fe. Commits since base: e3af1692, 41a741c2, 36f8d940 (plan) plus 5977111f, ae4b3c95, de8d73ba (foreign, see Findings).
PRD files found in `prds-archived/`. Gates re-run with a scratch TMPDIR.

## persona-tool-scope-primitive — VERIFIED
- Exports: `src/main/lib/claude/personaToolScope.cjs:63-68` (frozen floor `:19`, agent name `:21`, both functions).
- Null on null/empty/`*`: `:31-35`. Order, de-dup, disallowed removal: `:36-42`. Trim/blank drop: `:32-34`; MCP names untouched.
- `personaToolScopeArgs(null)` → `[]` (`:51`); otherwise `--agents <json> --agent sm-headless-scoped` with fixed description/prompt (`:52-60`).
- Tests present (`__tests__/personaToolScope.test.cjs`). Gate `vitest run personaToolScope.test.cjs`: 7/7 passed.

## prd-persona-resolve-returns-tools — VERIFIED
- `tools: null` on `miss` (`agentModelResolve.cjs:218`); `parseTools(fm.tools)` → list or null, never `[]` (`:233-235`); lazy require with `deps.parseTools` override.
- New tests in `src/main/__tests__/agentModelResolve.test.cjs` (+28 lines). Gate: 22/22 passed.

## wire-persona-tool-scope-into-job-spawn — VERIFIED
- `buildClaudeSpawnArgs` takes `toolScope`, spreads `personaToolScopeArgs(toolScope)` before `--dangerously-skip-permissions` (`scheduler.cjs:~4170`), so never between `--disallowedTools` and its value.
- Call site builds the scope once (`:~4461`) and passes `toolScope` in `jobArgs` (`:~4671`); the one `jobArgs` serves fresh and `--resume`.
- Log line prints `tools=<n> scoped` / `tools=unscoped` (`:~4462`).
- Tests (a)(b)(c) in `scheduler-resume-recovery.test.cjs`. README note added (`scheduler/README.md:189-193`) covering --agents/--agent, floor, and why not --allowedTools.
- Gates: 3-file vitest run 73/73 passed; `node --check src/main/scheduler.cjs` exit 0.
- Byte-identity: scratch script compared a verbatim copy of the base `buildClaudeSpawnArgs` against the new one for resume×systemPrompt×effort×toolScope∈{undefined,null} (16 combos): `IDENTICAL true`.

## Findings
### Critical
- none
### Important
- none
### Minor
- Combined base..HEAD diff also contains three commits outside this plan (5977111f `scripts/lib-layout.json`; ae4b3c95 `src/main/lib/activeSessions.cjs` + test; de8d73ba `src/main/scheduler/prdPaths.cjs` + tests). They are not part of the three PRDs; not reviewed for their own criteria. They also touched `epic-ancestor-prd-lookup.test.cjs`.
- `lib-layout.json` registration of personaToolScope is the one plan-related piece of 5977111f; fine.
- Review of plan code: no fs, no shell, no path handling in the new module; argv passed as array (no injection). Floor tools are intentionally granted even if persona omits them (documented). Self-review only (/code-review, /security-review not run).
