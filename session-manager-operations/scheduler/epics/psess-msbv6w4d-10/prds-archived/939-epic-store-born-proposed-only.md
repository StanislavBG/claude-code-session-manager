---
title: createPromptSession always mints 'proposed' — remove the 'active' creation path from the Epic store
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
sourcePromptId: psess-msbv6w4d-10
sourceTabId: 742e5d91-4827-43a4-9a96-84d368230c8b
---
# Goal

Enforce the CLAUDE.md domain-model law "Every Epic is born 'proposed'; nothing is created directly as 'active'" at the renderer store chokepoint. Incident 2026-08-02: Epic psess-msbv6w4d-10 was rogue-created as status 'active' because createPromptSession (src/renderer/state/promptSessions.ts:309) has `status = 'active'` as its DEFAULT parameter. Remove the ability to create an 'active' Epic entirely: createPromptSession drops its status parameter and always writes status 'proposed'; the ONLY route to 'active' becomes approveProposed (promptSessions.ts:335-343).

# Acceptance criteria

- [ ] src/renderer/state/promptSessions.ts: createPromptSession signature no longer accepts a status argument; every session it creates has status 'proposed'.
- [ ] duplicateEpic (promptSessions.ts:~483, currently passes explicit 'active') and resumeArchived (promptSessions.ts:~452, currently inherits the 'active' default) are rewritten to create 'proposed' then immediately call approveProposed — the same create-proposed+approve pattern EpicQueue.tsx:77-78 and ProjectPagesSection.tsx:85-86 already use, since both are direct user button clicks (explicit user intent, so immediate activation is correct, but the transition must still be proposed→active).
- [ ] Callers that passed 'proposed' explicitly (NewEpicCard.tsx:91, EpicQueue.tsx:77, ProjectPagesSection.tsx:85) compile against the new signature (drop the now-redundant argument).
- [ ] src/renderer/state/__tests__/promptSessions.test.ts lines that PIN the rogue default are rewritten: :66 (expects created status 'active'), :352 (resumeArchived), :929 (duplicateEpic) — new assertions: createPromptSession result is always 'proposed'; duplicateEpic/resumeArchived end 'active' only via the approveProposed transition (assert an intermediate 'proposed' write or that approveProposed was the activator).
- [ ] New regression test: createPromptSession called with no extra args (the incident shape from chat.ts:712) produces a 'proposed' session, never 'active'.
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/state/__tests__/promptSessions.test.ts passes

# Implementation notes

Read first: src/renderer/state/promptSessions.ts (createPromptSession ~:309, approveProposed ~:335, resumeArchived ~:452, duplicateEpic ~:483, persistActiveIndex ~:265-300), src/renderer/components/epics/NewEpicCard.tsx:84-91 (the comment there documents the born-proposed law — keep it accurate), src/renderer/components/epics/EpicQueue.tsx:70-85, src/renderer/components/tabs/projecthome/projectpages/ProjectPagesSection.tsx:80-90. The PromptSession status union stays 'proposed' | 'active' | 'completed' (promptSessions.ts:43) — this PRD changes who may write 'active', not the type. Note src/renderer/state/chat.ts:712 also calls createPromptSession relying on the 'active' default — a SIBLING PRD (chat-dispatch-never-mints-epics) deletes that call entirely; do NOT fix chat.ts here, just ensure the store compiles if that call is still present (it will now mint 'proposed', which is strictly safer). Working tree has uncommitted changes in promptSessions-adjacent files — do not revert anything you didn't touch.

# Out of scope

- chat.ts dispatch logic (sibling PRD chat-dispatch-never-mints-epics)
- main-process epicMint.cjs (sibling PRD)
- audit-log IPC (sibling PRD)
- any change to approveProposed's own behavior beyond being the sole activator

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
