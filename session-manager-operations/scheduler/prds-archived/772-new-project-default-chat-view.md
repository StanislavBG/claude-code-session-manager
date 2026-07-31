---
title: New-project tabs open in Chat view (dormant) instead of raw Terminal
cwd: ~/Projects/session-manager
estimateMinutes: 12
---
# Goal

Change the default view for a newly created project session from the raw xterm Terminal to the Chat view, so less technical users land in the friendly chat surface. Mechanically: a tab whose status is 'dormant' already renders TerminalChat (Chat view) — see src/renderer/components/Terminal.tsx:37 — but addTab in src/renderer/state/sessions.ts hardcodes status 'spawning' + a startupCommand, which boots the raw PTY. Add a dormant option to addTab and switch the new-session entry points to it. The user can still reach the raw terminal via the existing Chat→Raw toggle (wakeTab).

# Acceptance criteria

- [ ] addTab in src/renderer/state/sessions.ts accepts an optional `dormant?: boolean` (or equivalent) option; when true the created SessionTab has status 'dormant' and startupCommand null (no PTY spawn), all other fields unchanged; default (option omitted) keeps today's 'spawning' behavior so untouched callers are unaffected
- [ ] createPickedSession (src/renderer/lib/createPickedSession.ts) creates the tab dormant — no `claude --session-id` startupCommand string, no PTY; the minted UUID id is still passed so tab id = sessionId
- [ ] openInSession in src/renderer/lib/useKnownProjects.ts (Projects tab row click) creates the tab dormant the same way
- [ ] The 'new-tab-here' command-palette case in src/renderer/App.tsx (~line 711) creates the tab dormant the same way
- [ ] History-resume call sites (src/renderer/components/tabs/Home.tsx RecentSessionsCard and src/renderer/components/tabs/history/SessionLog.tsx) and simple-mode spawnLiveTabInCwd in App.tsx are left byte-identical — they must still spawn a live terminal
- [ ] Waking a dormant tab created via the new path (wakeTab) resolves a fresh `claude --session-id` command since no transcript exists yet — confirm resolveStartupCommand's freshStart=false path handles a never-run sessionId without generating a startupCommand referencing --resume (read the existing logic; add a unit assertion)
- [ ] Unit tests in src/renderer/state/__tests__/sessions.test.ts cover: dormant:true → status 'dormant' + startupCommand null; option omitted → status 'spawning' with the passed startupCommand; existing-id double-add guard still returns the existing tab id
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/sessions.test.ts` passes

# Implementation notes

Read first: src/renderer/state/sessions.ts (addTab at ~line 117 — currently hardcodes status: 'spawning'; SessionTab interface at top; wakeTab at ~line 207 shows the dormant→spawning transition and resolveStartupCommand), src/renderer/components/Terminal.tsx:37 (isDormant selector — dormant renders <TerminalChat/>), src/renderer/components/TerminalChat.tsx (the Chat view; headless chat runs are handled by src/main/chatRunner.cjs, first command uses --session-id so a never-started session works fine), src/renderer/App.tsx ~230-305 (spawnDormantTabInCwd shows the exact dormant tab shape already used for the empty-cockpit fallback — mirror it rather than inventing a new shape).

Pattern: extend addTab's opts with `dormant?: boolean`; when set, build the tab with status: 'dormant', startupCommand: null. Keep startupCommand in the opts signature (spawning callers still pass it). Callers to convert pass their existing presetId ('pick-dangerous', 'projects-tab') unchanged so restartTab's preset resolution still works after a later wake. In App.tsx 'new-tab-here', keep the setActiveNav('terminal') navigation — the Terminal nav destination hosts both views; dormant just means it shows Chat.

Persistence: hydrateSessions already restores every tab as dormant; the persisted fields (id, sessionId, cwd, label, presetId) don't change — no migration needed.

Do NOT touch src/main — this is renderer-only. Repo conventions: no CommonJS in renderer; tests run via vitest (this repo does not use node --test).

# Out of scope

- Changing history-resume flows (Home.tsx RecentSessionsCard, SessionLog.tsx) — they intentionally open a live terminal with --resume
- Simple mode (--simple) behavior
- Any new user-facing setting/toggle for choosing the default view — hardcode dormant/Chat as the default
- Redesigning TerminalChat or the Chat↔Raw toggle UI
- Main-process changes (chatRunner.cjs, pty.cjs)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
