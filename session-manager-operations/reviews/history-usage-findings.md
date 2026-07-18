# History tab + Usage tab review — findings

Deep review of the History tab (`History.tsx` / `HistoryDashboard.tsx` /
`history/SessionLog.tsx`), the Usage tab (`Usage.tsx` / `usage/UsageMeters.tsx`
/ `usage/SessionMatrix.tsx` / `usage/TopologyHeader.tsx` / `usage/AlertsStrip.tsx`
/ `usage/usage-primitives.tsx`), `BillingStatusBanner.tsx`, `state/billing.ts`,
`state/usageMatrix.ts`, `main/historyAggregator.cjs`, and `main/usage.cjs`.
Every file in scope was read. Typecheck and the six relevant vitest specs
(`historyAggregatorPricing`, `historyAggregatorCache`, `historyHandler`,
`billing`, `billing-data`) pass clean. The live app was exercised under
Playwright/xvfb (scratch spec, deleted after this pass) clicking through every
control on both tabs — date range, project filter, metric selector, heatmap
metric toggle, budget cap input, table column sort, manual refresh, and the
Usage tab's topology collapse toggle — with zero console errors on either tab.

## Fixed

1. **Usage tab went blank with no error banner on a `meter_rate_limited`
   billing response.** `main/usage.cjs`'s `registerBillingHandlers` classified
   HTTP 429-with-`rate_limit_error` responses as `meter_rate_limited`, but
   `BillingFetchResult` (`preload/api.d.ts`) had no such variant — so
   `getBillingData` (`state/billing.ts`) fell through its `if` chain to `null`
   and `BillingStatusOverlay` (`BillingStatusBanner.tsx`) had no matching
   `case`, silently rendering nothing. A rate-limited meter is a real,
   recoverable state (not rare — Anthropic's usage endpoint rate-limits under
   burst polling from multiple renderer consumers) and deserves the same
   "stale, showing cached" treatment as `auth`/`transient`, not a blank tab.
   Fixed end-to-end: added the `meter_rate_limited` variant to
   `BillingFetchResult`; `usage.cjs` now returns cached data + `staleSince` on
   this kind (mirroring the existing `auth` cached-fallback); `billing.ts`'s
   `getBillingData`/backoff-timer logic and `BillingStatusBanner.tsx` (new
   `MeterRateLimitedChip`) handle it explicitly. Added
   `tests/unit/billing-data.spec.ts` covering `getBillingData` across every
   `BillingFetchResult` kind including this one (red before the type/unwrap
   fix, green after).

2. **Duplicated token-count formatter, `usage/SessionMatrix.tsx` vs.
   `usage/TopologyHeader.tsx`.** Both files carried a byte-identical private
   `formatK`/`formatTokens` (1.2M / 340k / 12 formatting for token counts).
   Consolidated onto a single exported `formatCompactCount` in
   `usage/usage-primitives.tsx` (the designated shared home for Usage-tab
   primitives per `tierTone`'s existing precedent); both call sites now import
   it. Guards against future drift (e.g. one site's rounding silently
   diverging from the other).

3. **Dead duplicate usage-meter renderer in `BillingStatusBanner.tsx`.**
   `UsageBar`/`UsageBars` (a full second progress-bar rendering of the same
   `BillingData.usage` windows, with its own `formatResetAt`/`barColor`
   helpers) had zero call sites anywhere in the renderer — `usage/UsageMeters.tsx`
   is the actual, live renderer for this data (imported by `Usage.tsx`).
   Removed the orphaned pair plus their two private helpers.

## Findings — flagged, not fixed (per task scope)

4. **History tab's own header copy still advertises the session-resume UI
   that was intentionally removed.** `MainPane.tsx`'s `history` entry
   (`title: 'Every session, ever'`, `intro: 'Resumable transcripts across
   every project you have opened. Pick a row to reattach Claude to the same
   conversation.'`) and `AlmanacSidebar.tsx`'s nav hint (`'Every session, ever
   — resumable'`) both describe exactly the session browse/resume list that
   commit `85471da` ("refactor(history): drop dashboard/log toggle, isolate
   session-log for future relocation") deliberately pulled out of the History
   tab, stating in its own message that "History tab's charter is usage
   analytics only." The live History tab (confirmed via screenshot) shows only
   the analytics dashboard — no row-to-resume UI exists there today — so this
   copy is stale and actively misleading. Not fixed here: `MainPane.tsx` and
   `AlmanacSidebar.tsx` are shared, all-tabs files outside this review's listed
   scope (History/Usage family only), and this working tree had other PRDs
   concurrently landing commits against shared renderer files during this
   pass — editing a shared file outside the assigned scope risked colliding
   with that concurrent work. Recommend a follow-up PRD to correct the copy
   (e.g. to match `HistoryDashboard.tsx`'s own accurate intro: "Usage
   analytics across every project you have ever run Claude Code in — cost,
   tokens, and activity, trended over time").

5. **`history/SessionLog.tsx` is intentional, documented dead code — not new
   scope creep.** It contains exactly the session-search/preview/resume
   functionality (`filter by id or project`, a `resume` button that opens a
   directory picker and starts `claude --resume <id>`) that project convention
   says belongs to Terminal, not History. Investigated whether this is a
   regression: it is not. Commit `85471da` moved it out of `History.tsx`
   verbatim into its own file specifically so it stays "(exported,
   unrendered) pending a future PRD that relocates it onto Projects/Terminal."
   `History.tsx` today renders only `HistoryDashboard`; `SessionLog` has zero
   importers anywhere in the renderer. Its backing IPC handler
   (`history:scan-projects` in `historyAggregator.cjs`) is likewise only
   called from this dead component. Per this task's instructions, flagging
   rather than silently removing/relocating: the file's own history shows this
   was a deliberate hold, and the Projects tab it was originally slated for
   was since deleted (`5fd9b15`), so the relocation target is now Terminal
   only — worth an explicit decision (delete vs. relocate onto Terminal) in a
   follow-up PRD rather than assuming intent here.

## Cross-family duplication — noted, not touched (out of scope)

6. `HistoryDashboard.tsx`'s local `formatTokens` (1.2M / 340k / whole-number
   token formatting for the stacked bar chart) and Usage's
   `usage-primitives.tsx#formatCompactCount` are near-identical (both do
   M/k compaction on a raw token count; they differ only in decimal-place
   rounding for the `k` bucket — History uses `.toFixed(1)`, Usage uses
   `.toFixed(0)`). Per task scope this pass only consolidates duplication
   *within* each family (History-internal, Usage-internal — see fix #2
   above); cross-family consolidation is explicitly out of scope here. Worth
   a shared `lib/formatCompactCount.ts` in a future pass if a third call site
   appears.

## Not a bug (verified, left as-is)

- Delta chips showing "— vs prior period" for every stat on first load: the
  prior 30-day-equivalent window genuinely has zero sessions across all
  projects for this account, so `computeDelta`'s `previous === 0 → null`
  no-baseline path is correct, not broken.
- Usage tab's "No active sessions tracked yet" empty state for Session
  topology: correct — no live Claude tab was open in this session to populate
  `usageMatrixSnapshot.tabs`.
- `BillingStatusBanner.tsx`'s `StaleChip` destructures an unused `error`
  param (`error: _error`). Harmless dead prop, not a behavioral bug — left as
  a minor cosmetic note rather than "fixed" since the task scope is
  confirmed-bug fixes, not general cleanup.
