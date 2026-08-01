---
title: Global Home redesign — Active sessions + Recent sessions (bottom half)
cwd: ~/Projects/session-manager
estimateMinutes: 15
sourcePromptId: home-redesign-global-machine-home-per-project-br-fa12799f
dependsOn: [835-home-global-hero-usage-projects]
---

# Goal

Finish the machine-wide Home redesign (`src/renderer/components/tabs/Home.tsx`) per the "home-global" mock's bottom half: an "Active sessions" section listing the ≤3 machine session-slot holders as cards (owner, kind, project, Epic context, started-ago, Open button), and a redesigned "Recent sessions" table with columns id / project / epic / size / when / resume. This replaces today's `SchedulerPeek` 3-card section (running scheduler jobs now appear as Active sessions; the Scheduler tab owns the rest of the queue). PRD 835 already delivered the hero + usage/projects grid in the same file and left `RecentSessionsCard` + `SchedulerPeek` untouched for this PRD.

# Acceptance criteria

## Core functionality

- [ ] "Active sessions" section: serif h2 + right-aligned mono "N of 3 slots in use"; one `bg-bg-hi border-line rounded-[13px]` card per holder from `window.api.schedule.sessionSlots()` (reuse the hero's polled snapshot via props/context — do not add a second poll), showing accent dot + mono owner name + kind label ("scheduler job" / "chat run" when identifiable, else "session"), a second line "project · Epic · <goal/title>" when the join resolves, started-ago from `holder.at`, and an Open button.
- [ ] Open button routes: scheduler-job holders → `onNavigate?.('scheduler')`; chat-run holders → set the Epic deep-link (`lib/promptSessionDeepLink.ts` pending-id setter) then `onNavigate?.('terminal')`; unresolved holders → button hidden.
- [ ] "Recent sessions" table replaces `RecentSessionsCard`'s current row layout with the mock's 6-column grid (`92px / 1.2fr / 1fr / 80px / 74px / 78px`): mono 8-char session id, project name (bold), Epic title (or "—" when no Epic matches), mono transcript size, mono relative time, and a `sage`-toned "resume" pill button. Keep the existing scan (`useRecentSessions`) and resume handler (`addTab` + `claude --resume`, preset `history-resume`); raise the row count 4 → 5. "See all history →" link stays.
- [ ] `SchedulerPeek` and `JobCard` are deleted; clean-removal guard exits 0: `if grep -qE 'SchedulerPeek|JobCard' src/renderer/components/tabs/Home.tsx; then echo LEFTOVER && exit 1; else echo clean; fi`.

## Edge cases

- [ ] Zero holders: Active sessions section shows a quiet `text-fg-faint` one-liner ("No headless Claude sessions running."), not an empty card stack.
- [ ] A holder whose owner string matches no running job and no running chat still renders (owner + started-ago only).

## Tests

- [ ] New pure join helpers in `src/renderer/lib/homeSessionRows.ts`: `activeSessionRows(holders, jobs, chats, sessions)` and `recentSessionEpicTitle(sessionId, sessions)` (match on `PromptSession.claudeSessionId`, active or archived) with vitest coverage: `timeout 120 npx vitest run src/renderer/lib/__tests__/homeSessionRows.test.ts` passes.
- [ ] `timeout 120 npm run lint:selectors` passes (module-level `EMPTY_*` fallbacks; no fresh values built inside selectors).
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Read `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` ("Surface 1", "Data mapping notes") and the decoded mock `home-global-mock.jsx` beside it. Translate mock styles to Tailwind tokens; the resume pill's mock hexes (`#e3e6cf`/`#4a5730`) map to the `sage`/`sage-dark` token family.

Joins: `useScheduleState((s) => s.snapshot?.jobs)` rows have `slug`, `title`, `status`, `cwd`, `sourcePromptId` (Epic id) — a running job's slot-owner string contains its slug (inspect `src/main/lib/sessionSlots.cjs` acquire callers to confirm the owner format before hard-coding the match; substring match is acceptable). Running chats: `lib/useChatSignals.ts` chats keyed by Epic id (`running === true`, `queuedPosition === 0`), Epic via `usePromptSessions((s) => s.sessions)[epicId]` (`goalText`, `cwd`). Epic titles for Recent rows need archived Epics too — `usePromptSessions.getState().hydrate(cwd)` per known cwd, mirroring `EpicsWorkspace.tsx`'s `knownCwdsKey` hydrate loop. Per-session token counts from the mock are intentionally dropped (no live source) — see the spec's "Dropped / deferred" list; do not invent them.

PRD 835 (previous link) landed: redesigned hero with the polled `sessionSlots` snapshot, `BillingCard`, `ProjectsCard`, helper `src/renderer/lib/homeProjectRows.ts`. Build on its actual landed state (read the file first).

# Out of scope

- Project Home / Brief surface, nav or TabBar changes (PRDs 837–840).
- Any main-process or IPC changes; no new polling endpoints.
- Token columns for sessions (no data source).

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
