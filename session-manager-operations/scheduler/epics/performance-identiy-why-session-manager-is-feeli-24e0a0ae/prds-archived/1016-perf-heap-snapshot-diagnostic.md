---
title: Perf P11: add an on-demand renderer heap-snapshot path to settle whether a true leak remains
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

Renderer RSS was measured at 1,551 MB after 5h46m before this Epic's fixes and 773 MB after 14h59m with them — a ~50% improvement that confirms the retention causes (never-unmounted panels re-rendering, uncached markdown, ungated pollers) were real. But 773 MB is still high, and whether a TRUE leak (detached DOM, retained listeners, orphaned subscriptions) remains underneath is unmeasured, because taking a heap snapshot today means either enabling remote debugging on the live app or restarting it — and restarting SIGTERMs running scheduler jobs. Add a first-class, on-demand snapshot path so this question is answerable without babysitting a debugging session.

# Acceptance criteria

- [ ] An opt-in mechanism writes a V8 heap snapshot of the RENDERER process to disk on demand, without restarting the app and without leaving a debugging port open by default. Suggested shape: an env flag (e.g. SM_HEAP_SNAPSHOT=1) enabling a menu item / IPC command; the implementer may choose a better shape and must justify it in the result.
- [ ] The snapshot is written under ~/.claude/session-manager/ with a timestamped filename, and the destination path is logged and returned to the caller so it can be found.
- [ ] It is OFF by default: with no flag set, no snapshot capability is exposed and no debugging port is opened. A test asserts the default-off behaviour.
- [ ] Taking a snapshot does not kill, restart, or interrupt any running scheduler job or chat run. State in the result how this was verified.
- [ ] Snapshot capture is bounded: writing a multi-hundred-MB snapshot must not silently block the renderer forever — report progress or enforce a timeout, and say which.
- [ ] A short operator note (in the PRD result, or a doc under session-manager-operations/architecture/) explains how to take a snapshot and what to look for: detached HTMLElement retainers, listener counts, and retained size by constructor.
- [ ] The result includes ONE actual captured snapshot's headline numbers taken against a real running renderer (total heap size, top 5 retainers by retained size), so the leak question moves from unmeasured to measured.
- [ ] No new always-on overhead: with the flag unset, there is no added timer, listener, or allocation on the hot path. State how this was confirmed.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Electron exposes webContents.takeHeapSnapshot(filePath) from the main process, which is the path that avoids opening a debugging port — prefer it over --remote-debugging-port. Check the Electron 42 API surface before committing to a shape.

Key files: src/main/index.cjs (BrowserWindow + IPC registration), src/main/ipcSchemas.cjs (zod validation at the IPC boundary — any new channel must be validated there), src/preload/index.cjs if a renderer-facing trigger is wanted.

HARD CONSTRAINT: do not launch a second Electron instance to test this. The scheduler is live; a second instance SIGTERMs running jobs and clobbers admin-api.json. If capturing the AC7 snapshot requires the app, use the ALREADY-RUNNING instance (pid was 377635 for the renderer at time of writing — re-derive it, do not hardcode). If that is not possible without a restart, say so plainly in the result and deliver everything else rather than restarting the app.

Snapshot files are large (hundreds of MB). Do not commit one to git. Write to ~/.claude/session-manager/ and .gitignore it if needed.

Navigation is locked by design (setWindowOpenHandler denies, will-navigate allows only the dev URL) and createWindow hard-fails if dist/index.html is missing — do not weaken either while adding a diagnostic surface.

This is a DIAGNOSTIC PRD: its deliverable is a measurement plus the tooling to repeat it, not a fix. Do not attempt to fix a leak in this PRD; report what the snapshot shows and let the human decide the follow-up.

Main-process tests live in src/main/__tests__/ and run under vitest.

# Out of scope

- Fixing any leak the snapshot reveals (report it; a fix is a separate PRD)
- Enabling remote debugging by default or shipping an open debug port
- Restarting the running app or launching a second Electron instance
- Committing a .heapsnapshot file to the repo

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
