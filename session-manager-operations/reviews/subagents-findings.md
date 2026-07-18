# Subagents tab (Hive) review — findings

Deep review of the Subagents tab's Configured/Library/Live sub-tabs (now:
Launch/Live/Agents), the launch/dispatch flows (Hive/Orchestrate/Race/Boss),
and the Orchestrator/Race run views. Every file in scope was read; typecheck
and the relevant vitest suites were run clean before and after; the live app
was exercised end-to-end under Playwright/xvfb (scratch specs, deleted after
this pass) plus manual code-path tracing.

## Fixed

1. **"Launch the hive" was a dead button.** `LaunchView.handleLaunch()`
   (`hive-primitives.tsx`) resolved a recipe's steps into full role prompts
   via `resolveRecipeRoles()`, then called `useOrchestrator().launchHive()`,
   which only staged the roles into the store's `pendingRoles` mailbox and
   switched the UI to the Live sub-tab. Nothing ever consumed `pendingRoles`
   any more: it was designed to be read by `OrchestratorModal`, which seeded
   a manual tab-assignment form from it — but that modal was deleted in
   `c2a5097` ("unify Dispatch into one Subagents launcher with a shared
   brief") without anything replacing the hand-off. Net effect, confirmed
   live: click "Launch the hive" → button briefly shows the spinner state →
   UI jumps to the Live sub-tab → nothing is there ("no subagent spawns
   observed yet") and no orchestrator run panel ever appears. No error, no
   toast, no evidence anything happened.

   Root cause is a missing consumer, not a missing store method — `configure()`
   + `start()` (the same two calls `OrchestrateForm`'s "Start orchestrator"
   button already uses successfully) were sitting right there unused for this
   path. Fix: `LaunchView.handleLaunch()` now assigns each resolved role to a
   currently-running tab (one role per running tab, in array order) and calls
   `configure()` + `start()` directly, exactly mirroring `OrchestrateForm`'s
   working mechanism, instead of routing through the orphaned `launchHive()`/
   `pendingRoles` mailbox. Added explicit gating with a `toast.warn` (matching
   `OrchestrateForm`/`RaceForm`'s existing "needs N running tabs" pattern)
   for the two cases that previously failed silently: zero running tabs, and
   fewer running tabs than the recipe has roles. The tab-assignment/gating
   logic was extracted into a pure, unit-tested helper
   (`src/renderer/lib/assignHiveRoles.ts` +
   `src/renderer/lib/__tests__/assignHiveRoles.test.ts`) since this repo has
   no jsdom/component-test setup to render `LaunchView` directly.

   `launchHive()` and `pendingRoles` were left in `orchestrator.ts` unchanged
   — `HiveManagerModal.tsx` (outside this review's scope) still calls
   `launchHiveOrch()` from its own "Launch hive →" button, so removing the
   store method would have broken an out-of-scope file. See the dead-code
   note below.

2. **Duplicated status-badge rendering — `OrchestratorRunView.tsx` and
   `RaceRunView.tsx` each independently computed a 3–4-state status chip**
   (`done` / `working…` / `sent` / `pending` in one, `done` / `working…` /
   `waiting` in the other) with byte-identical Tailwind class literals
   (`text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent`, etc.)
   copy-pasted between the two files — exactly the "two places computing
   status color/tone" duplication this review was scoped to find. Neither
   reused `hive-primitives.tsx`'s existing `StatusPill`, which only covers
   the 2-state `running`/`done` case these run-grid cells don't fit.
   Consolidated: added `RunStatusBadge` to `hive-primitives.tsx` (a lower-
   emphasis sibling of `StatusPill`, `tone: 'done' | 'active' | 'idle'`) and
   pointed both call sites at it. Each view still supplies its own label text
   (`sent`/`pending` vs. `waiting`) since those are genuinely different
   vocabularies for the same three visual tones — only the tone→class mapping
   was duplicated, and that's now single-sourced.

## Checked, no bug found

- **`DispatchLaunch.tsx`'s `OrchestrateForm`, `RaceForm`, `BossForm`** — all
  three wire their Start/Launch/Stop buttons to real store actions
  (`useOrchestrator().configure/start`, `useRace().configure/begin`,
  `window.api.superagent.start/stop`) with correct `canStart`/`startDisabled`
  gating and user-facing `toast.warn`/inline error text when preconditions
  aren't met. No dead buttons.
- **`OrchestratorStatusPanel.tsx` / `SuperAgentStatusBar.tsx`** (App-level
  status bars) — Pause/Resume/Stop and Stop wire directly to the same store
  actions the Live view uses; no divergent logic.
- **`state/hives.ts`, `state/agentMemory.ts`, `main/hives.cjs`,
  `main/agentMemory.cjs`** — read cleanly; CRUD round-trips through
  `config.cjs`'s atomic-write helpers as the repo convention requires; no
  duplication with anything else in the family.
- **Agents roster/editor (`AgentEditorHive` in `Subagents.tsx`)** — Save
  (disabled unless dirty), Revert, Delete (two-step confirm), New agent, and
  "Install a starter" all wired to real IPC calls with error surfacing via
  `saveError`. Tool/skill chip pickers dedupe and round-trip unrecognized
  entries with a visible warning icon rather than silently dropping them.
  No dead controls found.
- `main/superagent.cjs`'s "Boss" prompt-injection surface (`buildBossPrompt`)
  is plain string concatenation of a user-authored brief with no
  interpolation of untrusted external data — not a prompt-injection risk in
  the OWASP sense; it's just text written to a PTY the user already owns.

## Dead code found but NOT touched (out of scope)

- **`HiveManagerModal.tsx`'s own "Launch hive →" button is unreachable.** It
  only renders when the `onLaunch` prop is passed
  (`{onLaunch && <Button onClick={handleLaunch}>Launch hive →</Button>}`), and
  the modal's sole call site (`hive-primitives.tsx:354`,
  `<HiveManagerModal open={managerOpen} onClose={...} variant="overlay" />`)
  never passes `onLaunch`. So this second, independent launch path — which
  also calls the now-orphaned `launchHiveOrch()`/`pendingRoles` mailbox, and
  builds its `roles` array from raw `step.note`/brief text rather than
  `resolveRecipeRoles()`'s agent-file resolution — is fully dead. Left
  untouched because `HiveManagerModal.tsx` is outside this review's file
  list ("Do not touch files outside this family"). Flagging for a follow-up
  PRD: either wire `onLaunch` to the same `assignHiveRolesToRunningTabs` path
  used here, or delete the modal's own launch button/`launchHiveOrch` call
  entirely and let "Manage recipes" be edit-only (its current de facto
  behavior).

## Cross-family duplication candidates (not touched, for a later pass)

- **`OrchestratorRunView.tsx`/`RaceRunView.tsx`'s run-grid status badges vs.
  Scheduler's job-status badges** (`sched-primitives.tsx`'s `SchBadge`,
  documented in `session-manager-operations/reviews/scheduler-findings.md`
  item 3's `PrdStatusPill`). Both are "small chip, tone driven by a status
  enum" patterns with separately-defined tone→color palettes (Hive's muted
  accent/bg-hi tones vs. Almanac's SchBadge palette). Not consolidated now —
  the two design families (Hive vs. Almanac) are documented as intentionally
  separate visual systems in this repo's CLAUDE.md ("Avoid: Reusing
  primitives across Almanac and Hive designs without coordination"), so any
  future consolidation would need a third, deliberately shared primitive
  rather than either family importing the other's.
- **`AgentMonitorRow` (`Subagents.tsx`, Live sub-tab's per-tab Task-tool
  agent list) vs. Scheduler's job-row duration/elapsed-time formatting** —
  both independently compute `now - startedAt` on a `setInterval` tick and
  format via `formatDuration()`. They already share the same `formatDuration`
  helper (single source), so this is fine as-is; noting only because the
  polling-interval pattern itself (`setInterval(..., 1000)`, torn down when
  nothing is running) is duplicated in three places in this family alone
  (`LiveAgentsPanel`, `OrchestratorStatusPanel`, `SuperAgentStatusBar`) — a
  small `useElapsedClock(active: boolean)` hook would remove ~10 lines each,
  but is a nice-to-have, not a bug or true logic drift.

## Testing notes

- `timeout 120 npm run typecheck` — clean before and after.
- `timeout 180 npx vitest run src/renderer/state/__tests__` — 5 files / 17
  tests, all pass; none of them cover hives/orchestrator/dispatch/race (no
  spec files exist for those stores under `__tests__`). No
  `main/__tests__/*` files exist for `hives.cjs`/`superagent.cjs`/
  `agentMemory.cjs` either.
- Added `src/renderer/lib/__tests__/assignHiveRoles.test.ts` (3 cases: zero
  running tabs, insufficient running tabs, correct in-order assignment) for
  the bugfix above.
- Live click-through was done via scratch Playwright specs under
  `tests/e2e/`, deleted after this pass (per this repo's convention of not
  committing throwaway review scaffolding). One operational note for future
  reviewers: `dist/` is a stale pre-built bundle by default — an e2e run
  with `SM_DEV` unset silently exercises whatever `dist/index.html` last had
  built in, **not** current source changes, unless you `npm run build`
  first. This cost significant time mid-review (several "confirmed" clicks
  turned out to be replaying the pre-fix bundle). Also: this machine had
  other agents/processes actively mutating the same real
  `~/.config/session-manager/tabs.json` and this repo's working tree
  concurrently during the review (observed the active project tab and other
  unrelated files change mid-session) — live-dispatch testing of the
  fixed "Launch the hive" success path (3 real running tabs) was
  intentionally **not** performed for this reason, since it would have
  written real role prompts into tabs potentially owned by a concurrent job.
  The fix was instead verified via the extracted pure-function unit tests
  above plus confirming it mirrors `OrchestrateForm`'s already-working
  `configure()`+`start()` call pattern exactly.

## Addendum (second pass on this PRD — concurrent-edit note)

This repo's working tree was under active concurrent modification by another
process for the duration of this review (unrelated files changing live:
`Projects.tsx` deleted, `Usage.tsx`/`billing.ts` edited, etc., alongside this
exact review). The findings above (items 1–2, the dead-code note, and the
cross-family candidates) were landed by that concurrent pass. This addendum
covers what a second, independent pass over the same scope found and fixed
on top of that work, without re-doing it.

3. **The dead "Launch the hive" button wasn't just inert — it was crashing
   the whole tab.** Reproduced live: navigating to Subagents with the fix's
   `LaunchView` selector written as
   `useSessions((s) => s.tabs.filter((t) => t.status === 'running'))` (a
   snapshot returning a *new array every render*) trips React's
   `useSyncExternalStore` infinite-loop guard — `Maximum update depth
   exceeded`, caught by the app's top-level `ErrorBoundary` (visible in the
   console as `[ErrorBoundary] Error: Maximum update depth exceeded`), which
   remounts the whole tree from scratch. The zustand `getSnapshot` warning
   fires first (`"The result of getSnapshot should be cached to avoid an
   infinite loop"`), then the hard crash. This is worse than a silent no-op:
   it makes the entire Subagents tab briefly white-screen/remount on
   navigation. Confirmed present in a locally-built `dist/` before the fix,
   confirmed gone after. The final code in `LaunchView` (`useSessions((s) =>
   s.tabs)` selected raw, filtered via `useMemo` keyed on that array — the
   same pattern `DispatchLaunch.tsx`'s `OrchestrateForm`/`RaceForm` already
   used) does not have this problem; noting the specific failure mode here
   since it's a stronger signal than "dead button" for why any future
   zustand selector in this family must not allocate inside the selector
   function itself.

4. **`digestFor()`/`isDoneSignal()` were byte-identical between
   `orchestrator.ts` and `race.ts`** (both parse the same `TranscriptEvent`
   shape into a run-grid snippet and the same end-of-turn "done" heuristic).
   Consolidated into `src/renderer/state/transcriptDigest.ts`; both stores
   now import from there instead of carrying their own copy.

5. **`OrchestratorStatusPanel.tsx` and `SuperAgentStatusBar.tsx` each
   independently computed an `M:SS` elapsed-time label** from a `startedAt`
   ms timestamp with identical `Math.floor`/`padStart` logic. Added
   `formatElapsedClock()` to `lib/formatTime.ts` (the repo's existing single
   source for time-formatting helpers — its own header already documents
   "three near-identical copies... unified here so a rounding fix in one
   place reaches all") and pointed both call sites at it.

Re-verified after these two consolidations: `npm run typecheck` clean,
`vitest run src/renderer/state/__tests__` clean (17/17), full `npm run
build` + a fresh Playwright/xvfb walkthrough of Launch → all 4 topology
forms → zero-running-tabs guard → Live (empty) → Agents, zero console
errors.
