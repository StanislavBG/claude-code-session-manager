# Validation: page fix wave 1

Base: d4a0615cabff05f87294c3f9b75dddf7b2a6e77d. Commits reviewed: 6b5e0f35, 3223a645, d4b42f26, ac838b01, 4d56ba18, b4b0be64 (plus merges).
Gates were re-run in the foreground with a scratch TMPDIR. The worktree has no node_modules, so a temporary symlink to the main checkout's was used and removed afterwards.
Combined gate run: vitest over the 7 gate targets passed (11 files, 84 tests). `npm run typecheck` exited 0. `node scripts/page-surface.cjs --duplicates` exited 0.

## ps-fix-persona-save-payload — VERIFIED
- `toKnownTags` filters through `TAG_LIBRARY`: src/renderer/lib/personaSavePayload.ts:13.
- `toPersonaSaveInput` copies every listed field, applies the defaults and `title ?? undefined`, then spreads `overrides` last: personaSavePayload.ts:17-36.
- Pure: it imports only types and `TAG_LIBRARY`, with no `window.api` or React (file read).
- The five-key preservation, unknown-tag and override-wins tests are in src/renderer/lib/__tests__/personaSavePayload.test.ts. They passed in the combined vitest run.

## ps-fix-savepersona-carry-over — VERIFIED
- Undefined `title`, `projects`, `action` and `actionLabel` take the existing file's values from the one `splitFrontmatter` read: src/main/agentLibrary.cjs:165-190. Projects are parsed with `parseTools` and the action fields with `decodeLine`, so both reuse existing helpers. A read failure carries nothing over.
- An explicit value wins, because carry-over only runs when the value is `undefined`. `projects: []` is not undefined, so it clears the field.
- Effort is not carried over (agentLibrary.cjs:166-170 comment, and `effort` is passed straight through).
- New cases are in src/main/__tests__/agentLibrary.test.cjs (+24 lines). They passed.
- The api.d.ts doc comments on the four fields were updated (src/preload/api.d.ts:320-326).

## ps-fix-session-slots-setter — VERIFIED
- `setSessionSlots` clamps to the snapshot's `[min, max]` when a snapshot is cached and does not clamp otherwise. It calls `window.api.schedule.setSessionSlots` once, then `pollOnce()`. Rejection propagates because nothing catches it: src/renderer/lib/useSessionSlots.ts:42-47.
- The clamp, re-poll and reject cases were added to useSessionSlots.test.tsx (+55 lines). They passed.

## ps-fix-taglibrary-preserve-fields — VERIFIED
- `assign` and `unassign` use only `toPersonaSaveInput(persona, { tags })`: src/renderer/components/tabs/TagLibrary.tsx:73-90.
- The local `KNOWN_PERSONA_TAGS` and `toKnownTags` are gone. A grep of src/renderer finds only the definitions in personaSavePayload.ts.
- The new five-field preservation scenarios (assign and remove) are in TagLibrary.test.tsx. They passed.

## ps-fix-agentlibrary-preserve-title — VERIFIED
- With an existing persona, the payload is `toPersonaSaveInput(existing, editorFields)`, and `tags` goes through `toKnownTags(obj.tags)`: src/renderer/components/tabs/AgentLibrary.tsx:~182-201. A new persona sends the editor fields alone, still through `toKnownTags`. The project-overlay path is untouched.
- The local tag helpers are removed (grep).
- The title-preserved-on-edit test was added to AgentLibrary.test.tsx. It passed along with projectOverride.

## ps-fix-session-slots-wire — VERIFIED
- Home.tsx:645 calls `setSessionSlots(n)` and toasts on rejection. SchedulerTopBands.tsx:463 calls `setSessionSlots(next)` with no `Math.min(10, …)` and toasts on rejection.
- `grep "schedule.setSessionSlots" src` outside tests finds only useSessionSlots.ts:45.
- `page-surface.cjs --duplicates` no longer lists `schedule.setSessionSlots` (grep count 0).

## End-to-end data-loss check
This ran in a scratch dir with an injected `globalDir`, not the real ~/.claude/agents.
1. `savePersona` wrote a persona with effort, title, projects, action and actionLabel.
2. A re-save with a hand-mirrored `toPersonaSaveInput` payload kept all five keys (builder: true/true/true/true/true).
3. A re-save that omits title, projects, action and actionLabel, as AgentLibrary did before the fix, kept all five via carry-over (true for all).

## Findings
### Critical
- none
### Important
- none
### Minor
- src/renderer/components/tabs/scheduler/SchedulerTopBands.tsx:463: the hardcoded 0..10 clamp is gone. With no cached snapshot (an unpolled first interaction) the value is sent unclamped. The control's `min`/`max` props (0..10) bound the UI and the main process presumably clamps, so the risk is low.
- The wave touches `src/renderer/components/tabs/scheduler/SchedulerTopBands.tsx`, which the Scheduler page owns. The PRD explicitly allowed it.
- Self-review (the code-review and security-review skills were not run) found no path traversal, secret handling or unsafe-input issues. `decodeLine` and `parseTools` are reused, and file paths still go through `validatePath`.
