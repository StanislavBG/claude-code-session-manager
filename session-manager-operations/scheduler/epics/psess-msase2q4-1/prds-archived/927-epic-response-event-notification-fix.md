---
title: Render Epic response events as markdown + surface completion as an actual notification
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msase2q4-1
---
# Goal

When a scheduler job completes, `notifyOriginatingTab` (`src/main/scheduler.cjs:1758`) appends a `'response'` PromptSessionEvent to the originating Epic's own event chain via `appendResponseEventIfKnown`, carrying the job's real result text. Two problems, confirmed by inspecting this session's own Epic after PRD 925 completed: (1) `ResponseEvent` (`src/renderer/components/epics/EpicDetail.tsx:97-146`) renders that text as raw plain text inside a bare `<span>` with zero markdown parsing (`{expanded && fullText ? fullText : event.text}`), so a result containing `**bold**`/backtick markdown renders as a literal, hard-to-read wall of asterisks instead of formatted text; (2) there is no proactive signal (toast, unread badge on the Epic row) when this event lands while the user isn't looking at that Epic's Chat panel — the only way to discover a PRD finished is to happen to scroll into the transcript. Fix both so a PRD-completion notification is actually readable and actually noticeable.

# Acceptance criteria

- [ ] `ResponseEvent` in `EpicDetail.tsx` renders `event.text` / `fullText` through whatever markdown renderer this codebase already uses for chat turn content (find it — check how a normal assistant `ChatTurn` renders its text elsewhere in this same file or in `ChatTranscriptTurn.tsx`, reuse that component/renderer rather than adding a second markdown library or hand-rolled parser)
- [ ] The rendered result stays visually distinct from a full chat turn (it's still a compact, centered, muted '— ... —' style event per the existing design, not promoted to a full chat bubble) — this is a rendering fix within the existing `ResponseEvent` visual treatment, not a redesign of how these events look
- [ ] A toast (`toast.info` or similar — check `src/renderer/state/toast.ts` for the right severity/call) fires when a `'response'` event is appended for an Epic that is NOT the currently-focused/selected Epic — find where new PromptSessionEvents get merged into renderer state (`mergeAppendedEvent` per `state/promptSessions.ts:213`, or wherever the `transcript:event`/equivalent IPC broadcast for this lands) and add the toast there, gated on kind==='response' AND epicId !== the currently active/selected epic id, so it doesn't fire redundantly for an Epic the user is already watching live
- [ ] The toast message is a short, useful summary (e.g. 'PRD <slug> finished — <Epic title>'), not the full result text truncated arbitrarily — the full text stays in the transcript event, the toast is just the 'hey, look at this' signal
- [ ] No duplicate/redundant toast fires for the SAME event on a page reload or re-hydration — check how `mergeAppendedEvent`/event hydration already distinguishes a genuinely-new event from a re-load of existing history before wiring the toast trigger, so historical events don't retroactively spam toasts
- [ ] `timeout 300 npm run typecheck` passes
- [ ] A test covering `ResponseEvent`'s markdown rendering (extend whatever test file already covers `EpicDetail.tsx`'s response-event rendering, e.g. `data-testid="epic-response-event"` per the existing markup) confirms markdown text renders as formatted output, not literal asterisks

# Implementation notes

Read `ResponseEvent` (`EpicDetail.tsx:97-146`) and `notifyOriginatingTab` (`scheduler.cjs:1758-1815`) in full first — this PRD touches the render side and the toast-trigger side, not the notification-firing logic itself (that part already works correctly, per the actual root-cause investigation this PRD was queued from). Check `state/toast.ts`'s existing API (`toast.error`/`toast.info`/etc., mentioned in this project's own CLAUDE.md as \"the user-facing error channel\") before assuming a new severity/call is needed. For the markdown renderer reuse, this project's CLAUDE.md may already document which component/library is the canonical one for chat-turn markdown — check there first before grepping blind.

# Out of scope

- OS-level/native desktop notifications (Electron Notification API) — in-app toast is the scope here, not system notification center integration
- Changing notifyOriginatingTab's resolution order or fallback logic — that mechanism already works, this PRD is purely about what happens once the event lands in the renderer
- Sound/audio alerts

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
