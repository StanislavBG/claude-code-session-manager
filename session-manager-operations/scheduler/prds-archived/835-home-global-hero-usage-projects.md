---
title: Global Home redesign — hero, usage card, projects card (top half)
cwd: ~/Projects/session-manager
estimateMinutes: 15
sourcePromptId: home-redesign-global-machine-home-per-project-br-fa12799f
---

# Goal

Redesign the top half of the machine-wide Home tab (`src/renderer/components/tabs/Home.tsx`, NavKey `overview`) to the Claude Design "home-global" mock: a "THIS MACHINE" kicker + serif hero headline showing the live session-slot count ("Good afternoon. N of 3 session slots are busy."), then a two-column grid of the existing UsageMeters billing card and a new compact Projects card listing known projects with live/activity chips that open or activate the project's tab. Removes the mascot hero, the tagline copy, and the Quick-start card (deliberate mock decision: "No Quick start; nothing invented"). Read `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` (section "Surface 1 — Global Home") FIRST — it is the authoritative layout + data-mapping contract for this whole PRD chain.

# Acceptance criteria

- [ ] `Home.tsx` renders: mono uppercase kicker "This machine" + a `font-serif` ~`text-[32px]` h1 whose "N of 3" span uses `text-accent`, where N comes from `window.api.schedule.sessionSlots()` polled every 5s (reuse the poll pattern currently in `SessionsPoolCard`; keep the existing greeting-by-hour helper).
- [ ] The old `Hero` mascot/tagline, `QuickStartCard`, and the `SessionsPoolCard` explainer paragraphs are removed from `Home.tsx`; the clean-removal guard exits 0: `if grep -qE 'QuickStartCard|Quick start|Mascot' src/renderer/components/tabs/Home.tsx; then echo LEFTOVER && exit 1; else echo clean; fi`. `RecentSessionsCard` and `SchedulerPeek` stay untouched in this PRD.
- [ ] Two-column grid (`minmax(0,1fr)` / ~300px): left = existing `BillingCard` (UsageMeters + BillingStatusOverlay reused untouched from `components/tabs/home/UsageMeters.tsx`); right = new `ProjectsCard` listing rows from `lib/useKnownProjects.ts`, each row: hashed color dot (`lib/projectColor.ts`), project name (last path segment, truncated), and a right-aligned mono chip showing "N live" in `text-accent` when the project has running work, else relative last-activity time.
- [ ] Clicking a `ProjectsCard` row activates the existing SessionTab whose cwd matches (one-TAB-per-project invariant: `useSessions` tabs have `.cwd`; call `setActive(tab.id)`) or calls `addTab({ cwd })` when none exists.
- [ ] Edge states: zero known projects renders a quiet `text-fg-faint` line inside the card, not a broken grid; billing failure still surfaces `BillingStatusOverlay` exactly as today.
- [ ] No zustand selector returns a freshly-built value (module-level `EMPTY_*` fallback constants; derive after selecting): `timeout 120 npm run lint:selectors` passes.
- [ ] A new pure row-model helper `src/renderer/lib/homeProjectRows.ts` (maps known-project rows + running chats/epics to display rows: name, cwd, dot seed, liveCount, lastActivityMs) has vitest coverage: `timeout 120 npx vitest run src/renderer/lib/__tests__/homeProjectRows.test.ts` passes.
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Read `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` first — it maps every mock element to real code and Tailwind tokens. The decoded mock is `home-global-mock.jsx` beside it; translate its inline hex styles to Tailwind tokens (`bg`/`bg-elev`/`bg-hi`/`line`/`rule`/`fg`/`fg-dim`/`fg-faint`/`accent`/`sage`; `font-serif` Newsreader, `font-mono` IBM Plex Mono) — NEVER port hex values, and do not copy the mock's `SMIcon` (use `components/layout/AlmanacIcon.tsx` if an icon is needed).

Current `Home.tsx` contents: greeting helper (keep), `BillingCard` (keep), `QuickStartCard` (delete), `SessionsPoolCard` (its `sessionSlots()` 5s poll moves into the hero; explainer copy deleted), `RecentSessionsCard` + `SchedulerPeek` (leave alone — PRD 836 owns them). `sessionSlots()` returns `{ total, inUse, holders: { owner, at }[] }`.

"N live" per project: join running chats to project cwds — `lib/useChatSignals.ts` returns chats keyed by Epic id with `.running`; `usePromptSessions((s) => s.sessions)[epicId].cwd` gives the cwd. Keep the join inside the pure `homeProjectRows.ts` helper so it is unit-testable with plain objects (no store mocking). `useKnownProjects` returns `{ rows: { encoded, displayPath, sessionCount, lastSession, path, sizeBytes }[], enriched }`; prefer `enriched[encoded].cwd`, fall back to `candidatePath(encoded)`. Relative-time helper `relativeTime` already exists in `Home.tsx`.

# Out of scope

- Active-sessions and Recent-sessions sections (PRD 836).
- Project Home / Brief surface, NavKey changes, TabBar changes (PRDs 837–840).
- Any main-process or IPC changes.

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
