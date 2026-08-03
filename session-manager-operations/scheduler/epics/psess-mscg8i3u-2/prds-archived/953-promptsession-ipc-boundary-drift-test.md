---
title: Enforce PromptSession schema at the IPC boundary + cross-path drift test
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-mscg8i3u-2
dependsOn: [952-promptsession-zod-schema-epicmint]
---
# Goal

PRD 952 (dependency) lands one canonical zod `PromptSessionSchema` (src/main/lib/promptSessionSchema.cjs) and wires it into `ensureEpic` (the main-process/CLI/scheduler mint path). The renderer's OWN construction path (`createPromptSession`, src/renderer/state/promptSessions.ts:352-364) never goes through `ensureEpic` — it sends its hand-built object over IPC via `mergeActiveIndex`, whose zod schema today validates only the envelope and treats each session's content as `z.unknown()` (src/main/ipcSchemas.cjs:217-248, `promptSessionsMergeActiveIndex`). Close that second gap: validate renderer-constructed PromptSession content against the same canonical schema at the IPC boundary, and add a regression test that would have caught the two-independently-hand-built-object-literals drift risk directly.

# Acceptance criteria

- [ ] `src/main/ipcSchemas.cjs`'s `promptSessionsMergeActiveIndex` (~line 217-248) requires `src/main/lib/promptSessionSchema.cjs` (landed by PRD 952) and replaces the `sessions: z.record(idRe, z.unknown())` field with `z.record(idRe, PromptSessionSchema)` (or an equally strict variant) — so a renderer-sent session object that doesn't match the canonical shape is now rejected at the IPC boundary before `activeIndexMerge.cjs` ever persists it.
- [ ] A deliberately malformed session payload (e.g. missing `claudeSessionId`, or an invalid `status` value) sent to the `promptSessions:mergeActiveIndex` IPC handler is rejected with a clear validation error and never reaches disk — verified by a new test.
- [ ] The renderer's real `createPromptSession` output (a normal call with just `cwd`/`goalText`, and a call that also sets `tag`+`agentType`) is asserted to VALIDATE CLEANLY against the same schema — this is the actual drift-detection test: if a future change to either `createPromptSession`'s object literal or the schema diverges from the other, this test fails. Since `createPromptSession` lives in a zustand store with renderer-only dependencies, either (a) extract the pure, side-effect-free `session` object-literal construction (id/cwd/goalText/claudeSessionId/status/createdAt/completedAt/tag/agentType) at promptSessions.ts:354-364 into a small standalone exported function with no `window.api`/zustand dependency that `createPromptSession` calls internally, so a plain node/vitest test can import and call it directly without mocking the Electron preload bridge, or (b) construct the equivalent object inline in the test and justify why that's an acceptable proxy — prefer (a), it's the more durable fix and directly reduces the duplication this whole PRD chain is about.
- [ ] New test file `src/main/__tests__/promptSessionSchema-crossBoundary.test.cjs` (or, if a shared-schema import makes more sense from the renderer test suite, an equivalent `tests/unit/promptSessionSchema-crossBoundary.spec.ts` — pick whichever side can cleanly `require`/`import` both the CJS schema and the renderer's extracted builder function, given this repo's `No CommonJS in renderer, no ES modules in main` convention applies to APP code, not test code) contains: the malformed-payload-rejected-at-IPC-boundary case above, and the real-createPromptSession-output-validates-cleanly case above.
- [ ] `timeout 300 npx vitest run <the new test file(s)>` passes.
- [ ] `npm run typecheck` passes with no new errors.
- [ ] Existing `mergeActiveIndex` IPC tests/flows for legitimately-shaped sessions (hydrate, New Epic creation, PRD-dispatch join) still pass unmodified — run the broader existing test suite touching promptSessions/activeIndexMerge and confirm no regression.

# Implementation notes

Read PRD 952's landed `src/main/lib/promptSessionSchema.cjs` first — its exact export names/shape may have settled slightly differently than PRD 952's own text described; don't assume, verify by reading the file. Read `src/main/ipcSchemas.cjs:217-248` (promptSessionsMergeActiveIndex) and `src/main/lib/activeIndexMerge.cjs:70-154` (mergeActiveIndex) before changing anything — the envelope-level checks (id regex, ≤2000 sessions, ≤5000 events) must stay exactly as they are, only the per-session content check changes. Read `src/renderer/state/promptSessions.ts:352-379` (createPromptSession) in full for the extraction in AC 3 — keep `createPromptSession`'s existing external behavior/signature identical; the extraction is an internal refactor only. For where main-process CJS tests already exist and how they're run under vitest, see `src/main/__tests__/scheduler-meta-code-sha.test.cjs` or `src/main/__tests__/activeIndexMerge.test.cjs` as a template.

# Out of scope

- Unifying the two different id-generation schemes.
- Any retroactive validation/migration of already-written active-index.json records already on disk.
- Tombstone pruning / active-index.json sharding (separate scale concern, not schema drift).
- Changing what fields createPromptSession sets — only extracting the existing construction into a testable pure function.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
