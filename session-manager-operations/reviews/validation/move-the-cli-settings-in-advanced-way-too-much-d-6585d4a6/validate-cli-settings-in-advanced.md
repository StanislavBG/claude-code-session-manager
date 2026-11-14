# Validation: CLI settings in advanced (PRDs 3049–3055)

Base `7528ccf9`; HEAD at validation = `cb7818bf`. PRD files found under the epic folder (3050, 3051 in prds/, the rest in prds-archived/).
Plan commits: dc2e5065 (3049), 362dced0 (3050), 8cf3343c (3051), 809a7cd0 (3052), 1f7a9911 (3053), 95a3ba50 (3054), cb7818bf (3055).

## Suite results (final tree)
- `npm run test:unit` (full): 1042 files passed, 10122 tests passed, 1 skipped, 0 failed. Because the full run covers every spec in every per-PRD gate, I did not re-run each scoped vitest command separately.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0. `npm run lint:docs`: exit 0.
- Real-path probe (temp HOME, `globalDir` pointed at a temp dir; real `~/.claude` untouched): a persona file with `agentCli: codex` and `agentCliModel: "@cf/x"` → `listPersonas` returned `codex` / `@cf/x`. `savePersona` with agentCli undefined kept both lines in the file.

## Per-PRD verdicts
- **persona-agent-cli-schema (3049): VERIFIED.** The schema (`agentPersonaSchema.cjs:97-104`) accepts agentCli and agentCliModel, rejects a model without a non-Claude CLI, and uses the shared `AGENT_CLI_MODEL_RE`. The tests in the full run pass.
- **persona-agent-cli-read-write (3050): VERIFIED.** The list/save/carry-over behaviour was confirmed by the real-path probe. The agentLibrary tests pass. Overlay saves are unchanged (`savePersona` routes to `saveOverlay` with model/effort only).
- **agent-cli-detect-shared-hook (3051): VERIFIED.** `src/renderer/lib/useAgentCliDetect.ts` exists with its test file. `AgentCliPicker` takes `testIdPrefix`. The picker and hook tests pass.
- **new-session-cli-in-advanced (3052): VERIFIED.** The NewEpicCard tests cover the criteria: advanced off gives no picker, no install rows and no detect call; codex shows the summary and the runtime CLI line. They pass.
- **new-session-cli-follows-agent-default (3053): VERIFIED.** `NewEpicCard.tsx:246-253` derives personaCli, pending, missing and in-effect state from `cliOverride`. `useAgentCliDetect(advanced || personaCli !== null)` makes no detect call for a Claude-only persona with advanced off. The missing warning is at `:843`. Tests pass.
- **agent-library-persona-cli-field (3054): VERIFIED.** The AgentLibrary.agentCli tests and the personaSavePayload carry-through test pass.
- **doc-agent-cli-persona-default (3055): VERIFIED.** domain-model.md and code-map.md were edited (diffstat), and `lint:docs` is green. Root CLAUDE.md is not in the diff.

## Combined-diff review
- Hooks: in NewEpicCard.tsx, `useAgentCliDetect` is called at `:248`, top level and before the early returns. Every early return in the file is inside a callback or effect, none at component level.
- Zustand selectors: the diff adds none that return a fresh value.
- Leakage: the persona `agentCli` is read only in NewEpicCard and agentLibrary. The scheduler, macro and phone paths do not read it.
- `/code-review` and `/security-review` were not run as separate commands. I reviewed the diff by hand for injection, path traversal and secrets. The model value is validated by `AGENT_CLI_MODEL_RE` (128 chars, restricted charset) and written double-quoted. I found no issues.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - Commit `448f5e2f` ("customer-feedback admin submit route") sits in the plan's base..HEAD range but belongs to no PRD in this plan. It touches `customerFeedbackAdminRoutes.cjs`, `customerFeedbackIpc.cjs` and their test. Its tests pass in the full suite. It is out of scope here and was not reviewed in depth.
  - The unit run had 5 `SM_*` env vars set. The result was green, so it doesn't change the verdicts.
