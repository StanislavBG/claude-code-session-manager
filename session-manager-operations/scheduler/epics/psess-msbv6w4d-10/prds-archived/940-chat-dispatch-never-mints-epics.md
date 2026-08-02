---
title: chat dispatchToPrd never mints an Epic — refuse dispatch when no resolvable Epic exists
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msbv6w4d-10
sourceTabId: 742e5d91-4827-43a4-9a96-84d368230c8b
dependsOn: [epic-store-born-proposed-only]
---
# Goal

Kill the incident path: on 2026-08-02 a user's follow-up feedback inside an Epic was classified 'develop' and dispatchToPrd() minted a brand-new Epic (psess-msbv6w4d-10) from the raw ticket text via resolveDispatchPromptSessionId (src/renderer/state/chat.ts:701-713). Sessions must NEVER create Epics — only the New Epic UI and the propose→approve flow may. Make resolveDispatchPromptSessionId join-only: if no Epic resolves, refuse the dispatch (fail the ticket with a clear toast telling the user to create/approve an Epic), never mint.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] resolveDispatchPromptSessionId (chat.ts:~701) no longer calls createPromptSession under ANY branch — it returns an existing PromptSession id or null; grep proof: no createPromptSession import/usage remains in chat.ts.
- [ ] When it returns null, dispatchToPrd fails the ticket via its existing failPrd() helper (chat.ts:~716) with a message telling the user no Epic could be resolved and to create one via the New Epic card (or Approve a proposed one) — surfaced via toast per the project's error-channel convention.
- [ ] ## Edge cases
- [ ] The stale-chainRootId branch (chat.ts:704-711, currently logs '… minting a new one' then mints) now refuses instead of minting; the warn log text is updated to say it refused.
- [ ] The refusal holds even when the sessions map has not hydrated: resolution falls back to reading active-index.json from disk (or triggering hydrate and re-checking) before giving up, so a not-yet-hydrated legitimate Epic is joined rather than refused — but an absent Epic is refused rather than minted. Do not rely solely on the in-memory sessions[tabId] guard at chat.ts:~521.
- [ ] ## Tests
- [ ] Rewrite the tests that PIN the rogue behavior: src/renderer/state/__tests__/chat.test.ts:718-731, :1144-1150, :1163-1202 ('dev-work ticket mints its own real PromptSession', expect(createSpy).toHaveBeenCalledTimes(1)) — they must now assert NO mint.
- [ ] New regression tests: (a) non-Epic tab + 'develop' verdict + no chainRootId → createPromptSession NOT called, window.api.chat.createPrd NOT called, ticket status 'failed', toast fired; (b) continuation ticket with unresolvable chainRootId → refuse, no mint; (c) Epic tab whose session exists on disk but not yet in the in-memory map → dispatch joins that Epic, no mint, no refusal; (d) cross-session notification shape — a ticket sent via the chat:external-send path (chat.ts:~917/:930, external: true), even with 'develop'-looking text (e.g. a scheduler "PRD authoring failed…" / completion notice), never reaches classifyPromptTicket or dispatchToPrd and never mints — pin the :507 external short-circuit with an explicit test, since the 2026-08-02 incident's trigger was exactly such a scheduler notification entering the classifier on a build that predated the guard.
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/state/__tests__/chat.test.ts passes

# Implementation notes

Read first: src/renderer/state/chat.ts (dequeueNext ~:490-544 incl. the external-ticket short-circuit :507 and Epic-tab guard :521; dispatchToPrd :715+; resolveDispatchPromptSessionId :701; failPrd :716; appendPrdCreatedEventFor helpers ~:580-660), src/renderer/state/promptSessions.ts (sessions map, hydrate(), activeIndexPath helper ~:84), existing chat tests in src/renderer/state/__tests__/chat.test.ts (note :658-703 already covers the Epic-tab inline guard — keep it green). Depends on PRD 939 (epic-store-born-proposed-only) having landed: createPromptSession no longer accepts a status arg — do not re-add any call to it here. Toast via useToast/toast.error per CLAUDE.md 'Toast is the user-facing error channel'. For the disk fallback, reuse the same window.api.config read path hydrate() uses — do not add a new IPC channel. Working tree has uncommitted changes in chat.ts — build on current state, don't revert.

# Out of scope

- Changing the classifier or dequeueNext ordering
- promptSessions.ts store changes (PRD 939)
- main-process epicMint.cjs changes (sibling PRD)
- Auto-filing a proposed Epic on refusal (explicitly rejected: refusal + user action is the desired UX)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
