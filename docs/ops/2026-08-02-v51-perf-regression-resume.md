# v51 perf regression — resume-after-reboot notes

**Written:** 2026-08-02, by an agent session diagnosing "v51 has big perf issues /
swapping between tabs and initial load feels very slow" reported by Bilko.
**Status when this was written:** fix implemented and locally verified
(typecheck + targeted unit tests green), **NOT committed, NOT pushed**. If the
machine rebooted before a commit landed, `git status` in the repo root will
show these as uncommitted working-tree changes — check there first.

## What was actually wrong (two distinct causes, not one "memory leak")

1. **`src/renderer/lib/useKnownProjects.ts`** — every mount re-scanned the
   entire `~/.claude/projects` tree from scratch (575 dirs / 2.3GB on this
   machine): sequential `listDir` per directory, then a concurrency-6 pass
   reading + parsing jsonl content per project. `EpicsWorkspace` (mounted by
   `Terminal.tsx` for the *active* dormant tab) remounts this hook on **every
   tab switch**, and `Home.tsx` mounts it **twice** on initial load. This is
   the direct cause of "swapping tabs / initial load feels very slow."

2. **`src/renderer/lib/useChatSignals.ts`**'s `signatureOf()` did an
   O(all chats × all turns) rescan on *every* `useChat` store update — i.e.
   on every streamed token from any running Epic anywhere. `useChat`'s
   `chats` map (`src/renderer/state/chat.ts`) also had no cleanup for closed
   SessionTabs, so it only ever grew for the life of the app process. The
   combination means the app gets progressively slower the longer it's been
   running and the more Epics have accumulated turns — everything that reads
   `useChatSignals` (EpicsWorkspace, Home, ProjectHome) pays the cost.

Diagnosis method: read `state/live.ts`, `TabBar.tsx`, `Terminal.tsx`,
`App.tsx`, main-process `transcripts.cjs`/`pty.cjs`/`config.cjs` watchers —
all correctly bounded/cleaned up, ruled out. Also ran a background Explore
agent over the same surface in parallel; it independently confirmed #2 and
ruled out the same main-process files. #1 was found by direct inspection
(`useKnownProjects.ts` has no caching, called from 5 sites) and confirmed by
`ls ~/.claude/projects | wc -l` → 575.

## Fix applied (uncommitted diff, working tree)

- `src/renderer/lib/useKnownProjects.ts` — converted to a module-level
  cached singleton shared across all 5 call sites (Home×2, EpicsWorkspace,
  NewEpicCard, ProjectsWorkspace), same pattern as `useHomeDir.ts`. Scans
  once per app session (keyed by resolved `$HOME`), not once per mount.
  Directory listing step parallelized (concurrency 6) instead of sequential
  `await` in a `for` loop. Added `refreshKnownProjects()` escape hatch for a
  forced re-scan if ever needed (not currently wired to anything — future
  use e.g. after adding a brand-new project directory mid-session).
- `src/renderer/lib/useChatSignals.ts` — `signatureOf()` now caches each
  chat's own signature "piece" in a `WeakMap<TabChat, string>` keyed by
  object reference, so an untouched chat isn't rescanned when a *different*
  chat mutates. `WeakMap` means stale entries GC themselves — no manual
  eviction needed.
- `src/renderer/state/chat.ts` — added `ChatState.dropTab(tabId)`, deletes
  the tab's `chats[id]` and `hydratedTabs[id]` entries.
- `src/renderer/state/sessions.ts` — `closeTab()` now calls
  `useChat.getState().dropTab(id)`. Safe: Epics aren't in `useSessions().tabs`
  and are never closed through this path, so Epic chat history (which needs
  to persist for the Epic's whole lifetime) is untouched — only a real
  SessionTab's own chat slice (e.g. from voice.ts's headless send) is
  dropped.
- Deliberately did **NOT** cap `TabChat.turns` itself (unlike
  `ticketHistory`, which already has `TICKET_HISTORY_CAP = 20`) — `turns` is
  the actual rendered conversation transcript in `EpicDetail.tsx`; capping it
  would silently truncate visible chat history the user can still scroll to.
  That's a product decision, not made here.

## Verification already done

- `npm run typecheck` — clean.
- `npm run lint:selectors` — clean (403 files).
- Targeted vitest runs, all green: `chat.test.ts` (part of a larger
  concurrent rewrite, see below), `sessions.test.ts`, `candidatePath.test.ts`,
  `homeProjectRows.test.ts`, `EpicsWorkspace.test.tsx`, `NewEpicCard.test.tsx`,
  `ProjectsWorkspace.navface.test.tsx` — 86+ tests passed across these files
  in the most recent run.
- Full `npm run test:unit` was run once mid-session and showed 9 failures —
  those were traced (by stashing this fix and re-running) to an **unrelated
  concurrent process**, not this fix. See below.

## IMPORTANT: a concurrent, unrelated process was editing this repo during the same session

While this diagnosis/fix was in progress, something else (almost certainly a
scheduler PRD job or the `builder` agent — not this session) was concurrently
modifying the working tree:
- `src/renderer/state/chat.ts` and its test file grew far beyond this fix's
  own diff — a second, unrelated change landed in the same file
  (`resolveDispatchPromptSessionId` was rewritten to never mint a new Epic
  from a follow-up ticket — see the new doc-comment in that function
  referencing incident `psess-msbv6w4d-10`, dated 2026-08-02). This session's
  `dropTab` addition and that rewrite coexist without conflict as of the last
  check (diff reviewed, both present).
- `package.json` version ticked from 0.51.0 → 0.52.0 mid-session without
  this session bumping it.
- Scheduler/Epic state files changed underneath this session:
  `session-manager-operations/scheduler/state/queue.json`,
  `.../scheduler/prds/.max-allocated-group`, several `.reserved-93x` files,
  `.../scheduler/epics/psess-msbv6w4d-10/`, an archived PRD
  `812-fix-test-legacy-only-1975929-233060.md`, `project-brief/brief.json`,
  `prompt-sessions/active-index.json`, and new transcript `.jsonl` files.
- At one point `src/main/scheduler.cjs`, `src/renderer/components/epics/EpicQueue.tsx`,
  and `vitest.config.ts` also showed as modified, then those three
  disappeared from `git status` again (reverted, or a rebase/reset by that
  other process) by the time this doc was written. **Do not assume the repo
  is idle** — re-run `git status` before touching anything.

**On resume:** don't blindly `git add -A && commit`. Diff each file in
`git status` and separate "my perf fix" (the 4 files listed under "Fix
applied" above) from whatever the concurrent process left behind, which may
need its own review/commit or may still be mid-flight.

## What's left to do on resume

1. `git status` — confirm what's still uncommitted and whether the
   concurrent process (scheduler job / builder agent) has settled or is
   still running (`npm run health` or check the Scheduler tab for a running
   job touching `chat.ts`/`scheduler.cjs`).
2. Re-run `npm run typecheck && npm run lint:selectors` and the full
   `npm run test:unit` once the tree is quiet, to get a clean read (the one
   full-suite run done this session was contaminated by the concurrent
   edits).
3. If clean, commit the 4-file perf fix (`useKnownProjects.ts`,
   `useChatSignals.ts`, `chat.ts`'s `dropTab` addition, `sessions.ts`) as its
   own commit — do not bundle it with whatever the concurrent process is
   doing to `chat.ts`'s dispatch logic; those are unrelated changes that
   happen to touch the same file.
4. Manually smoke-test in the running app (not just unit tests): open ~5+
   project tabs, switch between them rapidly, confirm no perceptible stall,
   and leave an Epic chat running for a while then switch tabs again to
   confirm it stays snappy. This wasn't done yet — only typecheck + unit
   tests ran; no live app verification.
5. Consider whether `refreshKnownProjects()` needs to actually be wired up
   somewhere (e.g. after "Open / Start Project" adds a brand-new project dir
   that wouldn't appear until next app restart otherwise) — added as an
   escape hatch but not yet called from anywhere.
