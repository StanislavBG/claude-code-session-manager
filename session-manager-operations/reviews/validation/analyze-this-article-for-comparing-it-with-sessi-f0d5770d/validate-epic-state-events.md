# Validation: epic state events plan

Base: 1421acb0871e7f492b49adaf914fd454ff85f7a2. Commits: 06442419 (watcher), 15579193 (tick), 56614c52 (reader), 555219e6 (route).
Gates re-run in the foreground: 8 test files, 81 tests passed; `npm run typecheck` exit 0.
Review tooling: self-review of the combined diff for these files (no unsafe input, secrets or path handling found).

## epic-state-watcher — VERIFIED
- `epicStateSnapshotPath()` defined and exported, `assertNotLiveRoot`-guarded: schedulerPaths.cjs:113, 206.
- `configureEpicStateWatcher` and `runEpicStateWatch` exported: epicStateWatcher.cjs (last line). Paging until `hasMore` false: readAllOpen; `isTabBusy` and `listJobs` passed in readerOpts.
- Snapshot `{version:1, epics}`, NUL-joined keys, `writeJsonAtomic`; `seeding` suppresses rows on the first run. Snapshot is written after the rows are appended.
- Rows via `appendAuditEvent('epic_state_changed', …)` for a new Epic (from null), a changed state or blockedKind, and a removed Epic (`closed` if the record has status completed, else `gone`). Empty optional fields are left out (`change()`).
- Other cwds' entries are kept (`next = {...prevEpics}`); a failing cwd is skipped via try/catch; the outer catch means it never rejects; `inflight` is shared across concurrent calls.
- Test file covers seeding, change/new/closed/gone, untouched cwd, failing cwd, same promise and paging. Gate green.

## epic-state-watch-on-tick — VERIFIED
- `runEpicStateWatchForTick(state)`: scheduler.cjs:1489. It uses `allProjectCwds` minus `quarantinedCwdSet(state)`, passes `jobs: state.jobs`, and returns early when `SM_EPIC_STATE_WATCH_DISABLE === '1'`. Exported at scheduler.cjs:12500.
- Tick call at scheduler.cjs:8212, directly after `reclaimTerminalJobOrphansThrottled`. It has no `await`, and `.catch` only calls `console.warn`. **Not awaited: confirmed.**
- `configureEpicStateWatcher({ isTabBusy: chatRunner.isTabBusy })`: index.cjs:121.
- Test file covers cwds/jobs, quarantine, the disabled variable and a rejecting watcher. Gate green.

## audit-events-reader — VERIFIED
- `OUTSIDE_EVENT_KINDS`, `readEventsAfter` returning `{events,next,more,gap}`; default kinds `epic_state_changed`; limit 100, capped at 500; target `auditLogPath()`: auditEvents.cjs.
- Cursor `<at>~<count>` with per-`at` ordinals (`withOrdinals`), so rows with the same timestamp are neither skipped nor repeated.
- `after` absent gives no events and `next` at the newest live row; `start` reads from the first row; a malformed cursor throws with `CURSOR_FORM` in the message.
- `caller` is removed, `more` is set at the limit, and `next` advances past every scanned row.
- The newest `audit-log-YYYY-MM.jsonl.gz` is read when the cursor is at or before the live first row; `gap` is set when the cursor predates the oldest readable row. The window starts at 1 MB and doubles.
- Tests: paging, same-timestamp, kinds, absent, start, malformed line, archive, gap. Gate green.

## events-read-route — VERIFIED
- `registerAdminRoute` in eventsAdminRoutes.cjs, called at index.cjs:114. GET `/admin/events` answers 200 `{ok,events,next,more,gap}`.
- Schema `adminListEventsQuery` at ipcSchemas.cjs:594, exported at :1642. Kinds are validated against the enum, limit is 1..500, and a cursor rejection (message prefix "invalid audit cursor") answers 400 `invalid query`.
- Tests cover 200, the kinds filter, the 400 cases (test.each at eventsAdminRoutes.test.cjs:135), 401 and no writes. Gate green.

## Cross-checks requested
- A watcher row is returned by GET /admin/events with default kinds: the watcher appends kind `epic_state_changed` and `readEventsAfter` defaults `kinds` to `['epic_state_changed']`. The route passes `input.kinds` as undefined when `kinds` is absent. Confirmed by reading.
- The tick does not await the watcher: confirmed (scheduler.cjs:8212).

## Findings
### Critical
- none
### Important
- none
### Minor
- auditEvents.cjs `readEventsAfter`: ordinals are computed over the archive and live rows concatenated, so a timestamp shared across the rotation boundary would count as one group. Highly unlikely and untested.
- eventsAdminRoutes.cjs:30: cursor rejections are detected by matching the error message prefix. This is brittle if the message in auditEvents.cjs changes. A shared error class or code would be safer.
