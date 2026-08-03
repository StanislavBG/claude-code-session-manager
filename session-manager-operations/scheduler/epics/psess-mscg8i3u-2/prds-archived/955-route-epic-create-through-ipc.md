---
title: Route renderer Epic creation through the single ensureEpic path
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 30
sourcePromptId: psess-mscg8i3u-2
dependsOn: [954-epic-create-ipc-handler]
---
# Goal

Eliminate the renderer's independent PromptSession construction — the actual duplicate "method path" flagged this session, not just its unvalidated shape. After PRD 954's `promptSessions:create-epic` IPC handler lands, convert `createPromptSession` (`src/renderer/state/promptSessions.ts:352-379`) to call it instead of building `id`/`claudeSessionId`/`status`/`createdAt`/`completedAt` itself. This makes `createPromptSession` async (`Promise<PromptSession>`) — a breaking change to its public contract. Every real and test call site must be updated in THIS SAME PRD so the tree is never red mid-chain; this is inherently one atomic, wide, mostly-mechanical change and is sized accordingly (30 min, the scope ceiling) rather than artificially split.

# Acceptance criteria

- [ ] `createPromptSession` becomes `async`, calls `window.api.promptSessions.create({ cwd, goalText, tag, agentType, source })` (verify PRD 954's actual final payload/response field names by reading its landed code — do not assume this PRD's own guess), stores the returned `session` in the zustand store exactly where the locally-built one used to go, keeps the existing `firstEvent`/`persistActiveIndex`-for-events/`emitAuditEvent` bookkeeping (only the session-object construction itself moves to main), and returns `Promise<PromptSession>`.
- [ ] No local `mintId('psess')` or `crypto.randomUUID()` call remains inside `createPromptSession` for the Epic's own `id`/`claudeSessionId` — main (`ensureEpic`) is now the only place either is generated.
- [ ] All real UI call sites are updated to await it: `src/renderer/components/epics/NewEpicCard.tsx` (~line 243-244), `src/renderer/components/epics/EpicQueue.tsx` (~line 105-106), `src/renderer/components/tabs/HostBilko.tsx` (~line 192-193), `src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection.tsx` (~line 139-140) — re-grep `createPromptSession(` across `src/renderer` at the start of this PRD since line numbers may have shifted since this was scoped; each caller's enclosing function becomes/stays async and uses the awaited result the same way it used the synchronous return before.
- [ ] `resumeArchived`'s internal call to `createPromptSession` (promptSessions.ts, ~line 504) is awaited.
- [ ] Every test call site in the renderer suite that calls `createPromptSession(...)` synchronously is updated to `await` it with an `async` enclosing test callback — re-grep `createPromptSession(` across `src/renderer` for the full current list (at scoping time this included `src/renderer/state/__tests__/promptSessions.test.ts` with ~90 call sites, plus `EpicDetail*.test.tsx`, `EpicDetailPrdsRuns.test.tsx`, `EpicTerminalPane.test.tsx`, `NewEpicCard.test.tsx`, `EpicsWorkspace.test.tsx`). Each test's `window.api` mock is extended so `promptSessions.create` returns a schema-valid session (check whether a shared mock/fixture helper already backs the existing `promptSessions.mergeActiveIndex` mock in these files and reuse/extend it rather than hand-rolling a new one per file).
- [ ] A newly-created Epic (via the New Epic UI path) now has an id in `ensureEpic`'s `<slug>-<uuid8>` format, not the old `psess-<ts>-<seq>` format — confirmed by at least one test asserting the id shape.
- [ ] `npm run typecheck` passes with no new errors.
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/promptSessions.test.ts` passes, and the other touched test files (see above) all pass.
- [ ] No PRD-953 IPC-boundary behavior regresses — `mergeActiveIndex` remains in use for post-creation mutations (event append, approveProposed, etc.); only Epic *creation* moves off the renderer-construction path.

# Implementation notes

Read PRD 954's landed handler and its exact request/response field names before writing this PRD's code. Expect most of the time budget to go to systematically updating the ~90+ test call sites (a scripted find/replace pass across the test files for the common `const session = store.createPromptSession(...)` → `const session = await store.createPromptSession(...)` shape, followed by a manual pass for tests with a different call shape or that assert on the old id format) rather than the core logic change, which is small. This is expected and fine — don't try to avoid the mechanical work by leaving some test files unconverted.

# Out of scope

- Further UI loading-state/error-handling polish beyond correctly awaiting/handling the promise at each real call site.
- Changing PRD 953's mergeActiveIndex IPC-boundary validation — it stays in place for non-creation mutations.
- Retiring `mintId`'s `psess` prefix support entirely if it's used for other non-Epic id kinds elsewhere — only Epic-id usage in createPromptSession is retired.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
