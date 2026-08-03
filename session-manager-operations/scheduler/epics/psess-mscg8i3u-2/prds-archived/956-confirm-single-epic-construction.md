---
title: Confirm single Epic-construction path, retire redundant drift test
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
sourcePromptId: psess-mscg8i3u-2
dependsOn: [955-route-epic-create-through-ipc]
---
# Goal

After PRD 955, `ensureEpic` (src/main/lib/epicMint.cjs) is the only place a PromptSession record is ever constructed — the renderer no longer builds one, it only receives and displays the record main returns. Close out this consolidation chain: update PRD 953's cross-boundary "drift" test (originally written to compare two independent constructors, which no longer exist) into a "there is exactly one construction path" structural guard, and fix doc comments that still describe the renderer as an independent producer of PromptSession records.

# Acceptance criteria

- [ ] Read how PRD 953 actually implemented its cross-boundary drift test (file name and exact assertions may have settled differently than PRD 953's own text described) before changing it.
- [ ] Replace or extend that test so it now asserts there is exactly ONE construction path: e.g. that `createPromptSession` never calls `mintId('psess')`/`crypto.randomUUID()` for the Epic id/session id itself, and instead always calls `window.api.promptSessions.create` — pick the smallest correct assertion that actually catches a regression (someone re-introducing local construction), not a cosmetic rename of the old test.
- [ ] `grep -rn "mintId('psess'" src/renderer` (or equivalent for however the id was minted before PRD 955) confirms no renderer code still mints an Epic id locally — other id kinds (e.g. `pevt` for events) are unaffected and out of scope.
- [ ] Doc comments that describe the renderer as a second producer of PromptSession records are corrected: `EpicSource`'s comment (`src/renderer/state/promptSessions.ts` ~line 17-21, currently "Written by src/main/lib/epicMint.cjs for auto-minted Epics; absent for human-created ones") and the `tag`/`openingPrompt` field comments on `PromptSession` (~line 49-51, ~58-60, currently "Also written by src/main/lib/epicMint.cjs") should instead state that ALL Epics (human-created via the UI or automated) are now constructed by `ensureEpic`/`epicMint.cjs`, with the renderer only receiving and storing the result.
- [ ] `npm run typecheck` passes.
- [ ] The full relevant test suite (the files touched by PRDs 954/955, plus this PRD's own changes) passes.

# Implementation notes

This is a small cleanup/verification PRD, not new feature work — read PRDs 952-955's actual landed diffs (via git log/git show on this repo, or by reading the current state of the touched files) before writing anything, since exact file names, function names, and line numbers described across this PRD chain were scoped mid-conversation and may have shifted slightly during execution of the earlier links.

# Out of scope

- Any new functional change to Epic creation — this PRD only updates a test's assertions and stale doc comments.
- Unsharding/pruning active-index.json or any other scale-related work — separate concern, not part of this chain.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
