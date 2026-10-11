# Validation: remote new-session plan

Base: 8b2230ba66f1a537ae1a8b0aceea2a5e94cedb62, HEAD caefcca7. All five PRD files were found in `prds-archived/`.
Gates: every PRD's own gate was a vitest run. The job worktree has no installed `node_modules`, so vitest failed at startup (`Cannot find package 'vitest'`). I could not re-run any spec. The validate PRD's gate is `none`, so the evidence below is from reading the tree and `git diff`. The test files exist and contain the cases the ACs name (listed per PRD).

## renderer-launch-session-primitive (1771) — VERIFIED
- Commit c48da446. `src/renderer/lib/launchSession.ts:24` exports async `launchSession` with the specified input and return shape.
- `launchSession.ts:31` calls `composeEpicIntake`, then `createPromptSession(cwd, goalText, tag, source, agentName, openingPrompt, sections)` (:32-34), then `approveProposed(session.id, source)` (:35), then `useChat.getState().send({tabId, sessionId, cwd, prompt})` (:36), and returns `{epicId, claudeSessionId}`. The order matches the AC.
- `launchSession.ts:26-29` throws on empty cwd, agentName, title or goal. It does not toast. `createPromptSession` errors propagate.
- `__tests__/launchSession.test.ts` has an order/args/return test and a propagation test. It has no explicit empty-input throw test (see Minor).

## web-remote-session-create-command (1773) — VERIFIED
- Commits 8719352f and 5ce093fa. `ipcSchemas.cjs` adds `remoteSessionCreate`, with the cwd, agentName, tag, title and byte-capped prompt constraints from the AC. It is exported under `schemas`.
- `ipcSchemas.cjs`: `cmd:session:options` is in `SAS_GATED_READS` and `cmd:session:create` is in `MUTATE_COMMANDS`, so both land in `ALLOWED_COMMANDS`.
- `chatRunner.cjs` adds and exports `requestExternalNewSession`, which calls `broadcast('chat:external-new-session', payload)`.
- `webRemote.cjs` `cmd:session:options` returns projects, agents, `EpicTagSchema.options` and macros as specified.
- `webRemote.cjs` `cmd:session:create` runs the zod parse first. It then rejects a cwd that is not exactly an open tab's cwd (`'cwd is not an open project'`) and a persona that is not listed (`'unknown agent'`). Only after both checks does it broadcast, and it returns `{ok:true}`.
- The spec `tests/unit/webRemoteSessionCreate.spec.ts` has the schema accept/reject cases, the tier-set test, the unknown cwd and persona rejections, and the valid-call test.

## macro-launch-uses-launch-session (1776) — VERIFIED
- Commit 8c08fe6b. `useMacroLaunch.ts` now imports `launchSession`. `composeEpicIntake` and `useChat` imports are gone.
- `useMacroLaunch.ts` calls `launchSession({cwd: activeTabCwd, agentName, tag, title: macro.label, goal, agentDescription, source: \`SessionActionsBar ${macro.agentName}\`})`, then `onSelect(result.epicId)`.
- `resumeActive`, the persona and readiness checks and the catch toast are unchanged (the diff touches only the compose/create/approve/send block).
- Commit c48da446 and the diff show a test-only change in `EpicQueueRowMenu.test.tsx`. The other macro-related tests were not re-run.

## renderer-remote-new-session-listener (1778) — VERIFIED
- Commits ab1941e6 and ba91c3c9. `preload/index.cjs` adds `chat.onExternalNewSession`, subscribing to `'chat:external-new-session'` and returning an unsubscribe, the same as `onExternalSend`. `api.d.ts` types it with the payload `{cwd, agentName, tag, title, prompt}`.
- `renderer/lib/remoteNewSession.ts` `registerRemoteNewSession` looks up the persona description (best-effort) and calls `launchSession({..., goal: prompt, source: 'WebRemote ' + agentName})`.
- On error it calls `toast.error('Phone session start failed: …')` and `window.api.logs.write('webRemote','warn',…)`, and never throws out of the listener.
- `main.tsx` calls `registerRemoteNewSession()` once, guarded by `typeof window.api?.chat?.onExternalNewSession === 'function'`.
- `remoteNewSession.test.ts` covers mapping and the failure toast.

## remote-app-new-session-sheet (1780) — VERIFIED
- Commit caefcca7. `SessionNav.tsx` renders a `+ New session` button per project group, with `aria-label="New session in <project>"`, using the `kind:'project'` entry's cwd. It opens `NewSessionSheet`.
- `Cockpit.tsx` passes `socket` and `deviceId` into `SessionNav`.
- `NewSessionSheet.tsx` calls `cmd:session:options` on open. It renders agent and tag selects, a title input (defaulting to the first 60 characters of the prompt) and a prompt textarea.
- Macro chips are filtered to those that are global (`projects` empty or `'*'`) or include the cwd. Tapping a chip prefills agent, tag, title and prompt.
- Start is disabled until agent, tag and prompt are set. It sends `cmd:session:create` with `{cwd, agentName, tag, title, prompt}`. On error it shows an inline alert and keeps the input.
- On success it closes the sheet. SessionNav shows 'Starting on your computer…'.
- `new-session-sheet.spec.tsx` has three tests: options and macros, prefill and exact payload, and error-keeps-open.

## Cross-checks
1. **Single-creator law holds.**
   - `lib/epic/epicMint.cjs:74` `MINT_AUTHORITIES` still has exactly two entries. The diff touches no epicMint file.
   - The phone path is `requestExternalNewSession` → renderer listener → `launchSession` → `createPromptSession`. `useMacroLaunch` calls the same `launchSession`. No new mint token was added.
2. **Tiers and allow-lists hold.**
   - `cmd:session:create` is in `MUTATE_COMMANDS` and `cmd:session:options` is in `SAS_GATED_READS`.
   - The zod parse, the cwd allow-list and the persona allow-list all run before `requestExternalNewSession` is called. The phone's cwd is only compared with persisted tab cwds and never touches the filesystem in main.
3. **Channel and payload agree across all four files.**
   - `'chat:external-new-session'` is used in `chatRunner.cjs`, `preload/index.cjs` (send and listen) and `api.d.ts` (type only).
   - `remoteNewSession.ts` consumes it through `chat.onExternalNewSession`.
   - Payload fields are `{cwd, agentName, tag, title, prompt}` everywhere.
4. **Phone payload matches the schema.** `NewSessionSheet` sends `{cwd, agentName, tag, title, prompt}`. The title is capped at 120 characters (`finalTitle`) and is never empty when Start is enabled. This matches `remoteSessionCreate`.

## Findings

### Critical
- None.

### Important
- None. Caveat: no spec was executed in this validation (vitest could not start in the worktree), so test-passing is unconfirmed. Re-run the five spec files from a checkout with dependencies installed.

### Minor
- `src/renderer/lib/__tests__/launchSession.test.ts`: there is no explicit test for the empty-input throws, although AC 1771 asks for one.
- `web/remote-app/src/components/SessionNav.tsx:~116`: the 'Starting on your computer…' notice is never cleared once set.
- `src/preload/api.d.ts`: the payload tag is typed `AgentPersonaTag` while the renderer uses `EpicTag`. The unions are identical today, but they are duplicated.
- `src/main/webRemote.cjs` `cmd:session:create`: the broadcast is fire-and-forget, so the phone gets `{ok:true}` even if no renderer is listening or `launchSession` later fails. The failure only toasts on the desktop. This is a design limit, not a bug.
- Security self-review (`/security-review` was not run separately): payloads are schema-validated, the cwd and persona allow-lists run before the broadcast, there are no secrets, and no path is built from phone input. No issues found.
