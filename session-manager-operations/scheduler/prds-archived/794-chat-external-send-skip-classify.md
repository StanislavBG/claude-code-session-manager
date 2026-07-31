---
title: External scheduler notifications must never enter the prompt-queue classify/develop-dispatch pipeline
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Confirmed live bug: scheduler completion notifications ("PRD NNN finished: completed. Check
Scheduler for details.") are delivered into an open chat tab via chatRunner.cjs's
enqueueExternalPrompt (src/main/chatRunner.cjs:688-689), which the renderer's onExternalSend
listener (src/renderer/state/chat.ts:640-648) hands directly to useChat.getState().send() — the
exact same path a human-typed composer prompt uses. If the tab is busy when the notification
arrives, send() (chat.ts:253-270) queues it as a PromptTicket; when dequeueNext() (chat.ts, the
'develop' dispatch flow added in PRD 773) later dequeues it, it runs the SAME classifyPromptTicket()
judgment call a real user prompt gets. When the classifier (a probabilistic LLM judgment, not
deterministic) misclassifies one of these status strings as 'develop', dequeueNext dispatches it
through PRD 773's chat:create-prd wiring and creates a REAL garbage PRD file whose Goal is
literally the raw notification text (e.g. "PRD 793-scheduler-commit-check-and-interactive-ac-lint
finished: completed. Check Scheduler for details."). This has now been observed live at least
twice (tickets 56054a77... and f4b276ed...) in this repo's own scheduled-plans/prds/ directory.
Fix: prompts delivered via onExternalSend must be marked as externally-originated end-to-end and
MUST skip classification entirely — always dispatched inline through chatRunner, never eligible
for the develop/PRD-creation path, since they were never a human's feature request to begin with.

# Acceptance criteria

- [ ] src/renderer/state/chat.ts's PromptTicket interface gains an `external?: boolean` field (or
      equivalent origin marker)
- [ ] chat.ts's send() action signature accepts an optional `external?: boolean` param and
      threads it onto the PromptTicket created in the queued-while-busy branch (~line 253-270)
- [ ] src/renderer/state/chat.ts:640-648's onExternalSend handler passes `external: true` into
      its send() call
- [ ] dequeueNext() (chat.ts) checks `next.external` BEFORE calling classifyPromptTicket(): when
      true, skip classification entirely and dispatch the ticket exactly like an 'inline' verdict
      (reuse the existing inline-dispatch branch, do not duplicate it) — an externally-originated
      prompt must never reach dispatchToPrd()/chat:create-prd under any classifier outcome
- [ ] Regression test in src/renderer/state/__tests__/chat.test.ts: an external-origin ticket
      queued while the tab is busy is dispatched inline without ever calling
      classifyPromptTicket (mock it and assert zero calls for this case), and without ever
      calling window.api.chat.createPrd
- [ ] Existing test coverage for the non-external 'develop' classification path (dispatchToPrd,
      chain continuation) is unaffected — run it and confirm still green, don't weaken those
      assertions to make the new test pass
- [ ] Search for and manually review any PRD files already created from a misclassified external
      notification (grep scheduled-plans/prds for a title/goal that looks like a raw "PRD NNN
      finished" status string rather than a real feature ask) and report them in the completion
      notes so a human can archive/delete the garbage ones — do not auto-delete PRD files as part
      of this PRD's execution, just identify and report
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/chat.test.ts` passes

# Implementation notes

Read first: src/main/chatRunner.cjs:680-717 (enqueueExternalPrompt + its admin route, confirms
this is genuinely system/external-originated, not user-typed — Web Remote, admin HTTP route, MCP
tool, and scheduler.cjs's notifyOriginatingTab are ALL callers), src/renderer/state/chat.ts in
full (PromptTicket interface ~48-61, send() ~253-337ish, dequeueNext() ~360-395ish,
dispatchToPrd()), src/renderer/state/__tests__/chat.test.ts's existing 'develop' classification
tests (search for "classified 'develop'" or similar) to mirror their mocking style for the new
external-skip test.

Do NOT change enqueueExternalPrompt's main-process side (chatRunner.cjs) — the bug is entirely in
how the renderer's onExternalSend handler feeds send(), and in dequeueNext() not distinguishing
ticket origin. Keep the fix renderer-only.

# Out of scope

- Improving classifyPromptTicket's own accuracy/prompt — the real fix is architectural (external
  prompts should never reach the classifier at all), not a better classifier
- Auto-deleting or archiving any garbage PRD already created — report only, human decides
- Changing enqueueExternalPrompt's callers (Web Remote, admin HTTP route, scheduler
  notifyOriginatingTab) — all of them are legitimately supposed to deliver a status/info message,
  the bug is purely in how the renderer queue treats that delivery

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
