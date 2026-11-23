# Validation: gemini-reads-agents-md

Base: f1ca1d3667c22c4bb2e3f9fb07f0fe5ea993304f. Commits: 27a4be79 (defaults file), 76548a86 (chat turns), e17231a6 (terminal).
Re-ran gates: `npx vitest run src/main/lib/agent-cli/__tests__` → 11 files, 104 tests passed; `npm run typecheck` → exit 0.

## gemini-context-defaults-file — VERIFIED
- Exports `ensureGeminiSystemDefaults({env,platform,fs,dir})` → `{path}` or null: geminiContextDefaults.cjs:68-87.
- Real path = env override else per-platform default: :31-35, :20-24; deep-merge of context.fileName (string/array) + AGENTS.md, GEMINI.md, deduped: :59-66, :76-80. CLAUDE.md not added (:8-9).
- Missing → {} (:46); unreadable/malformed/non-object → undefined → null, nothing written (:41-56, :75).
- Uses writeJsonAtomicSync under `rootDir()` (exported from agentCliSessionStore.cjs diff +1), rewritten only if content differs (:82-85).
- lib-layout.json maps geminiContextDefaults → agent-cli.
- Tests cover no file, string, array, env override, malformed, non-object, unreadable, unchanged-not-rewritten (test file lines 40-102).

## gemini-chat-turns-load-agents-md — VERIFIED
- agentCliTurn.cjs: gemini envExtra = auth env + `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` (geminiContextEnv :42-53, return block :110); null/throw → `{}` (no key, no error); other CLIs use `pickAuthEnv` only.
- Injectable via withDefaults (:26).
- Tests: gemini key, null/throw fallback, codex unchanged (agentCliTurn.test.cjs).

## gemini-terminal-loads-agents-md — VERIFIED
- agentCliIpc.cjs geminiEnvPrefix: `GEMINI_CLI_SYSTEM_DEFAULTS_PATH=${shellQuote(path)} ` for gemini on non-win32; '' on win32, null, throw, other CLIs (:96-110).
- `ensureGeminiSystemDefaults` and `platform` injectable (withDefaults :41-42).
- Tests: linux/darwin prefix with quote-containing path, win32, null/throw, codex unchanged.

## Combined diff review
Self-review (no extra tooling run): no secrets, value shell-quoted, file mode 0600, no path built from user input, reuses atomicFs and shellQuote.

## Findings
- Critical: none.
- Important: none.
- Minor: none. (Note: the terminal call omits `env`, so it reads process.env; same as the chat default. Consistent.)
