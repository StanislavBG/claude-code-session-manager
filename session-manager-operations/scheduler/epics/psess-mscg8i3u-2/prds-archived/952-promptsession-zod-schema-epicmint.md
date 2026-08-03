---
title: Canonical PromptSession zod schema, enforced in ensureEpic
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: psess-mscg8i3u-2
---
# Goal

Today `PromptSession` (src/renderer/state/promptSessions.ts:29-76) is a TypeScript-only interface with NO runtime validator anywhere. Two independent code paths hand-construct the same record shape from scratch: the renderer's `createPromptSession` (promptSessions.ts:352-364) and the main-process `ensureEpic`'s mint branch (src/main/lib/epicMint.cjs:309-329) — kept in sync only by doc comments, not by any shared schema. Create ONE canonical zod schema for the PromptSession record's content (a main-process CJS module, since zod is already a main-process dependency — see ipcSchemas.cjs:8) and make `ensureEpic` validate every session object it constructs against it before writing to active-index.json, closing the drift risk on the main-process/CLI/scheduler side first.

# Acceptance criteria

- [ ] New file `src/main/lib/promptSessionSchema.cjs` exports a zod schema (e.g. `PromptSessionSchema`) whose shape matches the TS `PromptSession` interface at src/renderer/state/promptSessions.ts:29-76 exactly: required `id` (string), `cwd` (string), `goalText` (string), `claudeSessionId` (string), `status` (`z.enum(['proposed','active','completed'])`), `createdAt` (string), `completedAt` (string or null); optional `resumedFromId` (string, nullable), `tag` (matches the `TicketTag` union already validated elsewhere in this codebase — find and reuse its existing zod enum rather than retyping the value list, e.g. check ipcSchemas.cjs's schedulerCreatePrd tag enum near line 349 and TicketTag's own definition), `openingPrompt` (string, nullable), `source` (an object matching `EpicSource` at promptSessions.ts:17-21: `producer` enum of `'rca-hook'|'feedback-sweep'|'propose-epic'|'scheduler-dispatch'`, optional `prdSlug`/`runId`/`sourceTabId` strings), `agentType` (string).
- [ ] The module also exports a small helper, e.g. `assertValidPromptSession(session)`, that calls `.parse()` (throwing a clear, descriptive error — not a raw ZodError dump — on failure) for call sites that want fail-closed enforcement.
- [ ] `src/main/lib/epicMint.cjs`'s `ensureEpic` mint branch (~line 309-329) validates the constructed `session` object against this schema via `assertValidPromptSession` BEFORE the `writeActiveIndex(cwd, index)` call at ~line 340 — an invalid shape throws and the write never happens, consistent in spirit with the existing BORN-PROPOSED LAW fail-closed check immediately above it (~line 299-305).
- [ ] A schema violation from this new check is logged via the same `appendAuditEvent('epic_mint_refused', ...)` pattern already used for the born-proposed refusal (~line 280, ~line 303), so a rejected mint is traceable the same way.
- [ ] Unit tests at `src/main/__tests__/promptSessionSchema.test.cjs` cover: a valid full record parses, a valid minimal record (only required fields) parses, missing a required field fails, an invalid `status` value fails, an invalid `tag` value fails, a `source` object missing its required `producer` fails.
- [ ] Unit tests extending or added alongside the existing epicMint tests (look for `src/main/lib/__tests__/epicMint.test.cjs` or similar) confirm `ensureEpic` still mints successfully for its normal real-world call shapes (no regression), and that a deliberately corrupted internal construction (simulate by monkeypatching or a targeted unit test of the validation call itself, since the real construction is hardcoded and should always be valid) is caught.
- [ ] `timeout 300 npx vitest run src/main/__tests__/promptSessionSchema.test.cjs` passes, and the full epicMint test file continues to pass.
- [ ] `npm run typecheck` passes with no new errors.

# Implementation notes

Read src/renderer/state/promptSessions.ts:1-110 (PromptSession + EpicSource interfaces, with their doc comments explaining which producer sets which optional field) and src/main/lib/epicMint.cjs:216-351 (ensureEpic, including the BORN-PROPOSED LAW block at 293-305 and the session object literal at 309-329) fully before writing the schema — don't guess field names or the enum's exact values. For the `tag` field's allowed values (`TicketTag`), grep the renderer's `lib/ticketDisplay.ts` (or wherever `TicketTag` is defined) for the authoritative list, and cross-check ipcSchemas.cjs's own tag enum (~line 349, `schedulerCreatePrd`) which already validates a closely related but not necessarily identical value set (that one includes 'build'/'project-home-builder' which may be PRD-scheduling tags rather than Epic-mission tags — verify before assuming they're the same enum). Keep this schema in `src/main/lib/` (plain CJS, no Electron dependency) so it's requirable from both `epicMint.cjs` and (in the next PRD in this chain) `ipcSchemas.cjs`.

# Out of scope

- Wiring this schema into ipcSchemas.cjs's IPC boundary (promptSessionsMergeActiveIndex) — that's the next PRD in this chain.
- Changing the renderer's TS PromptSession interface or createPromptSession — out of scope for this PRD.
- Unifying the two different id-generation schemes (psess-<ts>-<seq> vs <slug>-<uuid8>) — known separate drift issue, not addressed here.
- Any retroactive validation/migration of already-written active-index.json records on disk.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
