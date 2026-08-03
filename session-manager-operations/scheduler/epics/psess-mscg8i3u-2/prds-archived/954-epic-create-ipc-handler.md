---
title: IPC handler routing Epic creation through ensureEpic (additive)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-mscg8i3u-2
dependsOn: [952-promptsession-zod-schema-epicmint]
---
# Goal

Today there are two independent places a `PromptSession` record gets built: `ensureEpic` in `src/main/lib/epicMint.cjs` (used by automated/CLI/scheduler callers) and the renderer's own `createPromptSession` (`src/renderer/state/promptSessions.ts:352-379`), which hand-constructs the same shape itself. PRD 952 added schema validation to both, but the user has asked to go further and actually remove the duplicate construction, not just validate it. This PRD is step 1, purely additive: add a new IPC channel that lets the renderer create an Epic by calling `ensureEpic` in main, so a later PRD can make the renderer delegate to it instead of building its own object. Nothing calls this new handler yet — it must be safe to land with zero behavior change to the app today.

# Acceptance criteria

- [ ] A new zod schema in `src/main/ipcSchemas.cjs` (e.g. `promptSessionsCreateEpic`) validates `{ cwd: string, goalText: string, tag?: <the same tag enum PRD 952's PromptSessionSchema uses — import/reuse it, don't retype the value list>, agentType?: string, source?: <matching EpicSource's producer enum from PRD 952's schema> }`.
- [ ] A new handler (co-located with `ensureEpic` in `src/main/lib/epicMint.cjs`, or a small new sibling module if that reads cleaner — executor's call, but keep it next to ensureEpic conceptually) calls `ensureEpic({ cwd, goalText, tag, agentType, source, mintIfMissing: true, forceNewEpic: true, status: 'proposed' })` — read epicMint.cjs's actual `ensureEpic` parameter names/signature first (do not assume this exact option-object shape; confirm by reading the function, e.g. around line 216-230) — and returns `{ epicId, session }` where `session` is the just-written record read back from the index (not re-derived), so the response is guaranteed byte-identical to what's on disk.
- [ ] Registered as `ipcMain.handle('promptSessions:create-epic', ...)`, following the same registration pattern as `registerActiveIndexMergeHandlers` in `src/main/lib/activeIndexMerge.cjs:158-168` (schema-validated via `ipcSchemas.cjs`, wired into whatever central place calls `registerActiveIndexMergeHandlers()` today).
- [ ] `src/preload/index.cjs`'s `promptSessions` namespace (~line 481-496) gains `create: (payload) => ipcRenderer.invoke('promptSessions:create-epic', payload)`, and `src/preload/api.d.ts` gets the matching type signature.
- [ ] The handler's returned `session` object validates cleanly against PRD 952's `PromptSessionSchema` (`src/main/lib/promptSessionSchema.cjs`) — asserted directly in a test.
- [ ] A malformed request (missing `cwd` or `goalText`) is rejected by the ipcSchemas validation before `ensureEpic` is ever called — asserted in a test.
- [ ] No renderer code changes in this PRD — the new handler is unused by the app; `git diff -- src/renderer` is empty.
- [ ] New test file `src/main/__tests__/promptSessionsCreateEpicHandler.test.cjs` covers: a valid request mints a new proposed Epic and returns a schema-valid session; an invalid request is rejected pre-`ensureEpic`.
- [ ] `timeout 300 npx vitest run src/main/__tests__/promptSessionsCreateEpicHandler.test.cjs` passes.
- [ ] `npm run typecheck` passes with no new errors.

# Implementation notes

Read `src/main/lib/epicMint.cjs:216-351` (`ensureEpic`) fully before writing the handler — confirm exact parameter names, and confirm what `mintIfMissing`/`forceNewEpic` (or whatever the real option names are) actually do, since guessing wrong here would silently join an existing Epic instead of minting a new one. Read `src/main/lib/activeIndexMerge.cjs:158-168` for the handler-registration pattern to mirror, and `src/main/ipcSchemas.cjs:217-248` (`promptSessionsMergeActiveIndex`) for schema style/conventions in this file. Read PRD 952's landed `src/main/lib/promptSessionSchema.cjs` for the exact tag/source enum shapes to reuse (don't retype them a third time).

# Out of scope

- Wiring the renderer's createPromptSession to call this handler — that is the next PRD in this chain (route-createPromptSession-through-ipc).
- Removing createPromptSession's own object construction or id-minting — next PRD.
- Any test-file updates outside the new handler's own test file.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
