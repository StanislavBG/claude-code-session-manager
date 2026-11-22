# Validation: handoff-outcomes-one-entry-per-prd

Base: e41c402d (known). Commit for the PRD (3455): a852d6bb, touching only `src/renderer/lib/epicHandoff.ts` and `src/renderer/lib/__tests__/epicHandoff.test.ts`.

## handoff-outcomes-one-entry-per-prd — VERIFIED

- AC1 (key by bareSlug, bare slugs returned): `epicHandoff.ts:2` imports `bareSlug`; `:56` `const slug = bareSlug(prdSlug)`, `:58` `latest.set(slug, …)`; lists built from map keys.
- AC2 (validate PRDs ignored): `epicHandoff.ts:55` skips `agentType === 'validator'`; `:57` skips bare slug starting `validate-`.
- AC3 (numbered finish + bare verdict → one verified; no verdict → one unvalidated): tests in `epicHandoff.test.ts` ("merges a numbered finish event…", "lists a finished PRD with no verdict once…").
- AC4 (tests incl. refuted after numbered finish): test "a refuted verdict after a numbered finish event is one refuted PRD" plus the validator-ignore test, event shapes copied from real ones.
- AC5 (buildEpicHandoff and limits unchanged): `git show a852d6bb` changes only `summarizePrdOutcomes` and its doc comment; the constants are untouched. The 19 tests in the two gate files pass.

Gate (re-run): `vitest run epicHandoff + continueEpicFresh` → 2 files, 19 tests passed; `npm run lint` → clean (last check OK); `npm run typecheck` → no errors.

## Real-data run (read-only)

`summarizePrdOutcomes` run (strip-types on a temp copy) on this Epic's 267 events in `prompt-sessions/active-index.json`:

- verified: 64
- refuted: 0
- unvalidated: 4 (launcher-mix-kicker-matches-section, handoff-outcomes-one-entry-per-prd, continue-fresh-without-saved-agent, model-price-table — PRDs finished but not yet validated at run time)
- Slugs in more than one list: 0. `validate-*` slugs in any list: 0.

Before the fix: 64 verified and 81 unvalidated.

## Findings

- Critical: none
- Important: none
- Minor: none

Review: no `/code-review` run output beyond manual read of the 13-line source diff; no unsafe input handling, secrets, paths, or duplicated helper (reuses `bareSlug`).
