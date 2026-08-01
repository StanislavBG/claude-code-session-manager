---
title: Inline consent PTY backend — spawn/attach/detach scoped to one MCP consent grant
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: psess-msaj5sn3-8
---
# Goal

Today, granting MCP consent for a headless chat run forces the user through `useSessions.wakeTab()` (src/renderer/state/sessions.ts:217-239), which tears down the chat view and replaces the WHOLE tab with a full interactive Terminal (Terminal.tsx) — the "Grant consent →" button in ChatTranscriptTurn.tsx:424-432 already pre-queues `/design consent` via `queueRawCommand`, but the transition is a full-screen mode switch, not something scoped to just the consent prompt. Build the renderer-side plumbing for a MUCH smaller alternative: a short-lived inline PTY attachment, reusing the existing `window.api.pty.spawn/onData/onExit/resize` IPC (already used by both Terminal.tsx and the newer EpicTerminalPane.tsx at src/renderer/components/epics/EpicTerminalPane.tsx:94-114, which proves the same PTY manager can be mounted anywhere, not just the dedicated Terminal tab) and a NEW small xterm mount sized for ~6-10 terminal rows, not a full pane. This PRD is backend/plumbing + the mount component only — wiring it into the actual notice card happens in the next PRD in this chain (02-inline-consent-widget-notice-card).

# Acceptance criteria

- [ ] New component `src/renderer/components/InlineConsentTerminal.tsx` exporting `InlineConsentTerminal({ sessionId, cwd, command, onGranted, onClose }: Props)` — spawns/reattaches a PTY via `window.api.pty.spawn({ tabId: sessionId, cwd, cols, rows })` exactly like EpicTerminalPane.tsx:94-100 (same reattach guard), auto-types `command` (e.g. '/design consent') after the same resume-vs-create decision EpicTerminalPane.tsx:104-107 makes via `transcriptExists`, and renders a FIXED small height (e.g. 220px / ~10 rows) xterm instance — not full-pane sized (no `h-full w-full`)
- [ ] Mirrors EpicTerminalPane.tsx's teardown discipline: unmounting the component disposes the xterm view (term.dispose(), event listener cleanup) but does NOT kill the underlying PTY (window.api.pty.kill is never called from this component) — the PTY must survive so a subsequent headless chat resume against the same sessionId sees a clean, fully-exited session, matching the existing invariant documented in EpicTerminalPane.tsx:128-135
- [ ] Detects the consent grant succeeding by scanning PTY output text for evidence the interactive `/design consent` (or equivalent) flow completed (e.g. a stable success phrase distinct from the denial markers in chatRunner.cjs's MCP_CONSENT_DENIAL_MARKERS at chatRunner.cjs:196-202) and calls the `onGranted()` prop callback once when detected — write this detection as a small pure exported function (e.g. `hasConsentGranted(text: string): boolean`) with a unit test in `src/renderer/components/__tests__/InlineConsentTerminal.test.tsx`, not inline in the component, so it can be tested without mounting xterm
- [ ] A visible 'Close' control (rendered even before consent is detected) calls `onClose` — pressing it must leave the underlying PTY alone (per teardown rule above) so the user can reopen the widget later against the same live-or-dead session
- [ ] `npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/renderer/components/__tests__/InlineConsentTerminal.test.tsx` passes

# Implementation notes

Read /home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md before starting.

Reuse, don't reinvent: `writeInChunks` (exported from src/renderer/components/Terminal.tsx), `loadTerminalSettings`/`onTerminalSettingsChange`/`TERMINAL_THEMES` (src/renderer/components/TerminalControls.tsx), `canFit` (src/renderer/lib/terminalFit.ts), `transcriptExists` (src/renderer/lib/transcriptExists.ts), `getRawSessionModel` (src/renderer/lib/rawSessionModel.ts), `shellQuote` (src/renderer/lib/presets.ts) — EpicTerminalPane.tsx already imports all of these for the same PTY-mount pattern; follow its shape closely but with a small fixed-height container div instead of `h-full w-full`, and accept an explicit `command` prop instead of hardcoding the `claude --resume` launch line (the caller decides what to auto-type — for the consent case it's `/design consent`, not a claude launch command, since the PTY session already has claude running via the tab's own attach/resume flow — clarify in code comments that this component assumes an ALREADY-RUNNING claude REPL in the target sessionId's PTY, and only auto-types a slash command into it, not a fresh launch).

Do not add a `--session-id`/`--resume` claude launch inside this component — that concern belongs to whichever caller decides whether the underlying PTY needs a fresh `claude` process or already has one attached (the next PRD in this chain resolves that by checking chat.ts's running-state, same as wakeTab's cancel-then-resolve logic in sessions.ts:224-227).

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
