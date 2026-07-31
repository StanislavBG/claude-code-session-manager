---
title: Unify Chat and raw-session identity into a single sessionId
cwd: ~/Projects/session-manager
estimateMinutes: 25
---
# Goal

Terminal tab's Chat mode and "Open raw session" currently use two independent identities per tab: `SessionTab.chatSessionId` (chat's headless `claude -p --resume/--session-id`) and `SessionTab.claudeSessionId` (the raw pty's `claude --resume/--session-id`). This makes toggling between Chat and Raw feel like switching to a different conversation, when the user wants toggling to resume the SAME underlying claude session/transcript (`~/.claude/projects/<cwd>/<sessionId>.jsonl`) — Chat vs Raw should be purely a presentation/interactivity choice, not two separate contexts. Collapse both fields into one `sessionId` per tab, threaded through every consumer, and delete the now-stale two-ID collision-avoidance comments/logic. A follow-up PRD (queued separately, dependent on this one) adds the mutual-exclusion guard this unification requires between an in-flight Chat headless run and opening a raw session.

# Acceptance criteria

- [ ] `SessionTab` in `src/renderer/state/sessions.ts` has a single `sessionId: string` field (used as both chatRunner's `--session-id`/`--resume` value AND the raw pty's startup-command session id); `claudeSessionId` and `chatSessionId` fields are removed from the interface.
- [ ] `addTab` sets `sessionId: id` (mirrors the old `claudeSessionId: id` default) — no separate random UUID minted for chat at tab creation.
- [ ] `resolveStartupCommand` and `wakeTab` in `sessions.ts` operate on `sessionId` (param/field renamed from `claudeSessionId`); behavior unchanged — resume if the JSONL transcript exists for that id, else fresh `--session-id`.
- [ ] `restartTab` mints and assigns a fresh `sessionId` (was `claudeSessionId`) — intentionally now resets what BOTH Chat and Raw resume, since restart means a brand-new session for the tab as a whole.
- [ ] `newChatThread` is renamed to `newSession` and mints a fresh `sessionId` (was a fresh `chatSessionId` only). Its call site in `TerminalChat.tsx` (the 'New thread' button/action) is updated to call `newSession` and its label/tooltip is updated to reflect that it starts a brand-new session shared by both Chat and Raw (e.g. 'New session'), not just a new chat thread.
- [ ] `TerminalChat.tsx` derives `sessionId` from `tab.sessionId` (was `tab.chatSessionId`); the stale comment block explaining 'Chat uses its own dedicated session id, never the raw PTY's claudeSessionId ... caused a create-collision' is deleted (no longer true post-unification).
- [ ] `src/main/sessionsStore.cjs`: doc comment, `load`, `save`, and `markFreshRestart` all reference a single `sessionId` field only — `claudeSessionId`/`chatSessionId` removed everywhere in this file.
- [ ] `src/main/ipcSchemas.cjs`'s `sessionsPayload` zod schema: `tabs[]` has a single `sessionId: z.string().min(1).max(128)` replacing the separate `claudeSessionId`/`chatSessionId` fields.
- [ ] `src/preload/api.d.ts`'s `PersistedTab` interface has a single `sessionId: string` field; the 'backwards-compat' comment on the old optional `chatSessionId?` field is removed (single-author project, no compat shims per project CLAUDE.md).
- [ ] All remaining consumers updated to the unified `sessionId` field: `src/renderer/App.tsx` (tab-creation call sites passing `claudeSessionId`/`chatSessionId`), `src/main/webRemote.cjs` (`tabId: t.claudeSessionId` mapping and any other reference), `src/renderer/components/tabs/Usage.tsx`, `src/renderer/components/tabs/plans/SessionPlansView.tsx`, `src/renderer/components/tabs/editor/useDocEdit.ts` (the `runViaSession(backgroundSession.id, backgroundSession.chatSessionId, backgroundSession.cwd, ...)` call now passes `backgroundSession.sessionId`).
- [ ] `src/renderer/components/tabs/editor/__tests__/findBackgroundSession.test.ts` updated: test fixtures use a single `sessionId` override instead of separate `claudeSessionId`/`chatSessionId`.
- [ ] `src/renderer/state/__tests__/sessions.test.ts` rewritten: the existing test 'mints a fresh chatSessionId without changing claudeSessionId' is replaced with a test asserting `newSession(id)` mints a fresh `sessionId` for the tab (single field — there is no second id to assert unchanged).
- [ ] Confirm via `grep -rn "chatSessionId\|claudeSessionId" src/` that zero references remain anywhere under `src/` after the change.
- [ ] `npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run src/renderer/state/__tests__/sessions.test.ts src/renderer/components/tabs/editor/__tests__/findBackgroundSession.test.ts` passes.

# Implementation notes

Start by reading `src/renderer/state/sessions.ts` in full (the `SessionTab` interface, `resolveStartupCommand`, and every store action) — it's the canonical definition of the two-ID model being collapsed, including the doc comment on `chatSessionId` explaining the old collision (`"Session ID <uuid> is already in use"`) that this PRD's unification removes the *cause* of (see the follow-up PRD's mutual-exclusion guard, which is what actually prevents the collision from recurring — do not attempt to re-add a manual guard in this PRD, that's out of scope here).

Key insight that makes this a safe rename rather than a logic change: both `resolveStartupCommand` (sessions.ts, used for the raw pty) and `send()` in `src/renderer/state/chat.ts` already independently decide resume-vs-create by checking `transcriptExists(cwd, sessionId)` against the SAME on-disk JSONL file. Once both paths key off one shared `sessionId`, that existing logic composes correctly with no changes needed beyond the field rename.

Full list of files with `chatSessionId`/`claudeSessionId` references to check (from `grep -rn "chatSessionId\|claudeSessionId" src/`): `src/main/ipcSchemas.cjs`, `src/main/webRemote.cjs`, `src/renderer/state/browser.ts` (doc comment only — verify no field access), `src/main/sessionsStore.cjs`, `src/renderer/App.tsx`, `src/renderer/components/TerminalChat.tsx`, `src/renderer/state/browser.ts`, `src/renderer/state/__tests__/sessions.test.ts`, `src/renderer/state/sessions.ts`, `src/renderer/state/live.ts`, `src/renderer/components/tabs/Usage.tsx`, `src/renderer/components/tabs/editor/useDocEdit.ts`, `src/renderer/components/tabs/editor/__tests__/findBackgroundSession.test.ts`, `src/renderer/components/tabs/plans/SessionPlansView.tsx`, `src/preload/api.d.ts`.

`src/renderer/state/live.ts` references `tab.claudeSessionId` for transcript subscription — rename to `tab.sessionId`, no behavior change (it already subscribes by whatever id the raw pty uses, which is now the unified one).

This is a single-author project per the project's `CLAUDE.md` — do a clean rename throughout, no deprecated-alias/backwards-compat field kept around "just in case".

# Out of scope

- Mutual exclusion / guarding a chat run in flight when the user clicks "Open raw session" — that race is real once this PRD lands (it did not exist before, since the two ids were previously independent) but is handled by a separate, already-queued follow-up PRD. Do not add ad-hoc guards here.
- Changing chatRunner.cjs's spawn logic, stream parsing, or the raw pty's node-pty spawn logic in pty.cjs — this PRD is a field/identity rename only, not a behavior change to either runner.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
