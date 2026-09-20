# Scheduler screen — control → API map

Reference for the Scheduler UI redesign: every interactive control on the Scheduler screen (Queue / PRDs /
History sub-views, plus the Machine pill), the exact `window.api.*` call or local state mutation it fires, its
enable/disable/hidden predicate, and its `data-testid`. Derived from source on 2026-09-19 (HEAD `cf9bf76`);
**line numbers drift — re-grep before relying on one.** Documentation only; nothing here changes behaviour.

Conventions: `SP` = `src/renderer/components/SchedulePanel.tsx`; `SCH` = `src/renderer/components/tabs/Scheduler.tsx`;
`PRDS` = `src/renderer/components/tabs/plans/SchedulerPrdsView.tsx`; `HIST` = `.../plans/SchedulerHistoryView.tsx`.
`schedule.*` / `supervisor.*` = `window.api.schedule.*` / `window.api.supervisor.*` (`src/preload/api.d.ts`).
`toast.fromOutcome` shows the returned `ActionOutcome`; unmarked API calls swallow the result. "—" = no testid.

## 1. Scheduler.tsx shell — sub-tab pills + WindowStrip

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| Queue / PRDs / History pills | `tabs/scheduler/SchedulerSubTabs.tsx:27` (options at `SCH:53-57`, wired `SCH:326`) | `setSubView(key)`; effect persists to `localStorage['sm.schedulerTab.subView']` (`SCH:293`, read `SCH:270`) | never | — |
| ⚙ Machine | `SCH:329` | `setSubView('machine')` (`aria-pressed` when active) | never | — |
| Learning panel (`LearningPanel active="scheduler"`) | `SCH:304` | opens the learning panel (own component; no scheduler API) | never | — |
| Pause | `SCH:142` | `schedule.pause()` | hidden when `snapshot.paused` truthy | — |
| Resume (pause banner) | `SCH:159` | `schedule.resume()` | banner only when `snapshot.paused` | — |
| Retry now (per-persona launch-block banner) | `SCH:194` | `schedule.resume()` | one banner per entry of `snapshot.launchBlocks` | `launch-block-banner` (banner, `SCH:171`) |
| — launch-mitigation banner | `SCH:205` | none (informational) | one per entry of `snapshot.launchMitigations` | `launch-mitigation-banner` |
| — stats row (reset countdown, pending/running/completed-today, utilization, last batch) | `SCH:219-` | none, read-only from `useScheduleState()` snapshot | hidden until snapshot loads | — |

## 2. QueueHealthHeader.tsx

Read-only. `schedule.queueHealth(scopeCwd)` on mount, on `scopeCwd` change, and every `POLL_MS` (15 s) (`QueueHealthHeader.tsx:72`).
Stats shown: slots, oldest running, pending, dispatchable, needs_review, last batch fired, last dispatch attempt (`:110-137`).
No buttons. Root element `data-testid="queue-health-header"` (`:89` unknown state, `:103` verdict state) with `data-verdict-kind`.
Renders nothing until the first result; renders a muted "Queue health: unknown" box when `result.unknown`.

## 3. SchedulePanel.tsx — status banner + PolicyBar

Whole panel replaced by FirstRunGuide (§3a) when `jobs.length === 0` (`SP:256`) and by SupervisorPanel (§7) when
`panelView === 'supervisor'` (`SP:241`).

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| Pause (status banner) | `SP:329` | `schedule.pause()` | hidden when `paused` | — |
| status action button (label from `computeStatus`) — **Resume** | `SP:339`, defined `SP:812-816` | `schedule.resume()` | only when `paused` and no running jobs (paused branch is after the running branch, `SP:775`) | — |
| status action — **Fire next batch now** | `SP:339`, defined `SP:830-834` | `schedule.forceTick().then(toast.fromOutcome)`; catch → toast "Failed to fire batch" | only when `firePolicy === 'manual'`, not paused, nothing running, `pending+running > 0`. Other kinds (`running`, `idle`, `on-reset`, `auto-*`) have no action | — |
| Dismiss (meter banner) | `SP:358` | `setMeterBannerDismissed(true)` — local only | banner only when `health.consecutiveFailures > 5 && lastFailureKind === 'meter_rate_limited' && !paused && !meterBannerDismissed` (`SP:351`) | — |
| Start jobs `<select>` (when available / only on reset / manually) | `SP:374` | `schedule.setConfig({ firePolicy })` | never | — |
| Up to `<input type=number 0..10>` … at once | `SP:397` | `schedule.setSessionSlots(Number(value))` | `disabled` when `effectiveConcurrency.source === 'env'` (an `env` badge shows, `SP:389`) | — |
| Pause above `<input type=number 0..100>` % of window | `SP:418` | `schedule.setConfig({ utilizationThreshold })` | rendered only when `(firePolicy ?? 'when-available') === 'when-available'` (`SP:415`) | — |
| Fire next batch now | `SP:433` | `schedule.forceTick().then(toast.fromOutcome)`; catch → toast "Failed to fire batch" | `disabled` when `counts.pending === 0 && counts.running === 0` (`SP:436`) | — |
| Refresh | `SP:442` | `schedule.rescan().then(toast.fromOutcome)`; catch → toast "Failed to rescan" | never | — |

### 3a. FirstRunGuide (`SP:691`)

| Control | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| Go to Sessions → | `SP:724` | `navigate?.('terminal')` (prop; no-op if `navigate` undefined) | rendered on step 1 only (`isNow`, `SP:723`) | — |

## 4. SchedulePanel.tsx — job table header + FilterBar + row list

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| filter jobs… (text input) | `SP:1482` (`FilterBar` `SP:1463`, mounted `SP:471`) | `setFilter({...filter, text})` + `saveFilter` (`SP:473`); only `status` is persisted (`SP:59`, key `sm.scheduler.queueFilter`), text is not | mounted only when `jobs.length > 0` | — |
| All / Running / Investigating / Pending / Completed / Skipped / Needs review / Failed / Quarantined chips | `SP:1493` → `ui/FilterPills.tsx:25` | `setFilter({...filter, status})` + `saveFilter` | same | — |
| Clear completed | `SP:490` | `onClearCompleted` (`SP:279`): adds every completed/failed slug to `hiddenSlugs` and writes `localStorage['sm.scheduler.hiddenCompletedSlugs']`. **No API.** | rendered only when `hasInlineCompleted` (`SP:489`) | — |
| Archive & clear queue… | `SP:499` | `onClearQueue` (`SP:285`): `window.confirm(...)` then `schedule.clearQueue()`; `!r.ok` → `toast.error` | `disabled` when `jobs.every(j => j.status === 'running')`; also early-returns if zero non-running victims | — |
| Epic section header (chevron + label + rollup) | `SP:1039` (`EpicSectionBlock` `SP:1032`) | local `setExpanded(v => !v)` | never | `backlog-epic-section` (wrapper, `SP:1038`), `backlog-epic-label` (`SP:1052`) |
| "Plan N of M" head label | `SP:561` | none (label) | only when an Epic section has > 1 head | `backlog-head-label`; group wrapper `backlog-head-group` (`SP:559`) |
| ▸/▾ "N more completed" | `SP:595` | `setShowAllCompleted(v => !v)` — local | rendered only when `collapsedCount > 0` | — |
| un-hide (nested span inside the toggle) | `SP:606` | `onUnhideAll` (`SP:295`): clears `hiddenSlugs` + localStorage, `setShowAllCompleted(false)`; `stopPropagation` | rendered only when `hiddenSlugs.size > 0` | — |
| Job row button | `SP:1173` | local `setOpen(v => !v)`; `onFocus → onFocused(listIndex)` persists focused index. ArrowUp/ArrowDown on the list (`SP:524`, handler `SP:199`) moves focus between `[data-job-row]` buttons | never | attrs `data-job-row`, `data-job-index`, `data-depth`, `aria-expanded`; inline read-only testids `job-row-parallel-eligible` (`SP:1195`), `job-row-cycle-warning` (`SP:1204`), `job-row-blockers` (`SP:1209`), `job-row-hold` (`SP:1227`), `job-row-held-reason` (`SP:1234`) |
| Footer: supervisor | `SP:638` | `setPanelView('supervisor')` | never | — |
| Footer: folder | `SP:646` | `schedule.openFolder()` | never | — |

`<div role="list" aria-label="Job queue">` (`SP:520`) is the row list container; there is no per-row Fire/Cancel button —
firing is batch-level only (§3).

## 5. JobRow expanded "Actions" block (`SP:1341-1389`)

Visible only after the row button toggles `open`.

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| view epic → | `SP:1344` | `navigateToPromptSession(id)` (`SP:1138`): `setPendingPromptSessionId(id)` + `window.dispatchEvent('sm:navigate', 'terminal')`. **No API.** | rendered only when `linkedPromptSession` (resolved via `resolveEpicRef` + `sessions[epicId]`) | `job-row-prompt-session-link` |
| view log → | `SP:1355` | `setShowLog(true)` → mounts `RunLogViewer` (`SP:1393`) which calls `schedule.readLog(runId, slug)` (`RunLogViewer.tsx:42`) | rendered only when `job.runId` | — |
| adopt PRD → | `SP:1364` | `schedule.adoptPrd(slug).then(toast.fromOutcome)`; catch → toast "Failed to adopt PRD" | rendered only when `job.status === 'quarantined'` | `job-row-adopt-prd` |
| reset to pending → | `SP:1377` | `schedule.resetJob(slug)` | rendered when status is none of `pending` / `running` / `quarantined` (`SP:1376`) | — |
| change disposition… `<select>` (promote to new head / attach behind: <label>) | `SP:1435` (`DispositionControl` `SP:1422`) | `schedule.setPrdDisposition({slug, cwd, disposition, dependsOn}).then(toast.fromOutcome)`; `__new-head__` → `'new-head'`, sibling head → `'append'` + that head's terminal slugs; select resets to placeholder | control mounted only when `job.disposition` set and status `pending`/`quarantined` (`SP:1385`); component returns null when `disposition !== 'append' && headChoices.length === 0` (`SP:1432`); `disabled` while a call is in flight | `job-row-disposition-control` |

RunLogViewer modal (opened by view log →; also used by HIST): Parsed (`RunLogViewer.tsx:64`) / Raw (`:71`) →
local `setMode`; × close (`:79`) → `onClose`; "open Raw for full" (`:148`) → `onSwitchRaw`, shown only when truncated. No other API than `readLog`.

## 6. DiagnosticsSection (`SP:1657`)

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| Diagnostics toggle (dot + summary) | `SP:1710` | `setOpen(!open)` → parent `showHealth` — local | never | — |
| rerun lint (label `…` while loading) | `SP:1759` | `getLintQueueCached({ fresh: true })` (`lib/lintQueueCache.ts:24` → `schedule.lintQueue()`) | inside expanded panel, only when `report` loaded | — |

Not controls but API-fed: on mount / `jobs.length:lastRunAt` change → `getLintQueueCached()` (`SP:1677`); parent `SP:123` fetches
`schedule.health()` on mount and on every `schedule.onState` event.

## 7. SupervisorPanel (`SP:1500`; shown via footer "supervisor")

Mounted with `onSetConfig = (s) => schedule.setConfig({ supervisor: s })` (`SP:245`).

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| ← queue | `SP:1532` | `onBack` → `setPanelView('queue')` | never | — |
| refresh | `SP:1541` | `supervisor.getLog().then(setLog)` (also auto-fetched on focus, `SP:1515`) | never | — |
| enabled (checkbox) | `SP:1556` | `setConfig({ supervisor: { enabled } })` | never | — |
| interval … min (number 5..60) | `SP:1566` | `setConfig({ supervisor: { intervalMinutes } })` | never | — |
| probes (number 1..5) | `SP:1578` | `setConfig({ supervisor: { maxConcurrentProbes } })` | never | — |
| stale … min (number 5..30) | `SP:1589` | `setConfig({ supervisor: { probeStaleThresholdMinutes } })` | never | — |
| — probe log rows (`SupervisorLogRow` `SP:1621`) | — | none, read-only from `supervisor.getLog()` | "No probes yet." when empty | — |

## 8. SchedulerPrdsView.tsx

Data: `schedule.listPrds()` on mount (`PRDS:108`), live snapshot via `useScheduleState`. Archived PRDs filtered out (`excludeArchived`).

### 8a. Card list (no PRD selected)

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| + New PRD | `PRDS:417` | `handleNewPrd` (`:263`): `schedule.writePrd('new-prd-<ts>', template)` → `schedule.listPrds()` → `openPrd(slug)`; failure → `toast.error` | never | — |
| select-all — none exists | — | `toggleAllVisible` (`:224`) is defined but **never wired to a control** | — | — |
| per-card checkbox | `PRDS:480` | `toggleChecked(slug)` — local `checked` Set | never | — |
| N selected → Archive… | `PRDS:430` | `setArchiveOpen(true)` | bar shown when `checked.size > 0` | — |
| N selected → Retag… | `PRDS:437` | `setRetagOpen(true)` | same | — |
| N selected → Clear | `PRDS:444` | `clearChecked()` — local | same | — |
| card title button | `PRDS:491` | `openPrd(slug)` → `setSelectedSlug`; effect opens the file in `useEditor` (`:182`) | never | — |
| card slug button | `PRDS:520` | `openPrd(slug)` | never | — |
| Epic tag (`EpicTag`) | `PRDS:504` → `sched-primitives.tsx:199` | `openEpic(epicId)` → `setPendingPromptSessionId` + `sm:navigate 'terminal'` | interactive only when epic resolves (`known`) | `epic-tag` (default `testId`, `sched-primitives.tsx:165`) |
| Re-fire | `PRDS:535` | `schedule.resetJob(slug)` | shown only when `j.status === 'needs_review'` | — |
| Queue job / Running… | `PRDS:547` | `schedule.runNow()` — **not per-PRD**: fires all pending jobs; slug is not passed | `disabled` when `j.status === 'running'` | — |

Modals (`Modal`, mounted `PRDS:564-577`):

| Control | file:line | Fires | Disabled | testid |
| --- | --- | --- | --- | --- |
| Archive PRDs → Cancel | `PRDS:603` | `onClose` | `busy` | — |
| Archive PRDs → Archive N | `PRDS:611` | `confirmArchive` (`:283`): `schedule.archivePrds([...checked])` → `refreshPrds()` (`schedule.listPrds()`) | `busy \|\| count === 0` | — |
| Retag PRDs → parallelGroup (0–999) / estimateMinutes inputs | `PRDS:684`, `:696` | local `groupStr` / `estimateStr` | — | — |
| Retag PRDs → Cancel | `PRDS:708` | `onClose` | `busy` | — |
| Retag PRDs → Retag N | `PRDS:716` | `submit` (`:645`) validates then `confirmRetag` (`:307`): `schedule.retagPrds(items)` → `refreshPrds()`; remaps open editor tabs via `useEditor.renameOpenFile` | `busy \|\| count === 0` | — |

### 8b. Editor view (a PRD selected)

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| ← PRDs | `PRDS:357` | `closeEditor` → `setSelectedSlug(null)` | never | — |
| Reset | `PRDS:367` (`TBtn` `:56`) | `schedule.resetJob(selectedSlug)` | `disabled` unless `status === 'failed'` (via `prdStatusFor(job)`) | — |
| Run now | `PRDS:373` | `schedule.runNow()` | never | — |
| Last run log / Hide log | `PRDS:378` | `handleShowLog` (`:199`): `schedule.readLog(job.runId, slug)` into `logText`, toggles `showLog`; no `runId` → local "no log available" text | never | — |
| close (log pane) | `PRDS:395` | `setShowLog(false)` | pane shown when `showLog && logText !== null` | — |
| body editor | `<EditorView />` `PRDS:386` | shared `useEditor` store; file writes go through the editor store, **not** `schedule.writePrd` | — | — |

## 9. SchedulerHistoryView.tsx

Data: `schedule.getHistory()` once on mount (`HIST:48`); no refresh control, no `onState` subscription. Scope filter (`scopeCwd`) is applied client-side.

| Control (UI text) | file:line | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- | --- |
| All / Completed / Skipped / Failed chips | `HIST:100` → `ui/FilterPills.tsx:25` | `setStatusFilter` — local | filter bar hidden while loading / on error / when history is empty | — |
| All projects `<select>` | `HIST:105` | `setProjectFilter` — local | rendered only when `projects.length > 0` | — |
| from (date) | `HIST:119` | `setFromDate` — local | — | — |
| to (date) | `HIST:128` | `setToDate` — local | — | — |
| clear | `HIST:140` | resets status/project/from/to — local | rendered only when any filter is active (`hasFilters`) | — |
| History row button | `HIST:189` | local `setExpanded(v => !v)` | never | — (`aria-expanded`) |
| Epic tag | `HIST:207` → `sched-primitives.tsx:199` | `openEpic(epicId)` (`HIST:13`) → `sm:navigate 'terminal'` | rendered only when `epicRef.epicId` | `epic-tag` |
| view log → | `HIST:251` | `setShowLog(true)` → `RunLogViewer` → `schedule.readLog` | only when `job.runId`; `stopPropagation` | — |
| reset to pending → | `HIST:260` | `schedule.resetJob(slug)`; **no toast, no confirm** | only when `job.status !== 'pending'`; `stopPropagation` | — |

## 10. Machine pill (SessionManagerConfig)

`SCH:371` renders `<SessionManagerConfig navigate>` (`tabs/SessionManagerConfig.tsx:30`), which mounts `GlobalControlsSection`
and a "open to Home on launch" preference toggle (`:94`, a prefs call, not scheduler API). Its scheduler-API touchpoints are
read-only display via `useSessionSlots()` (`lib/useSessionSlots.ts` → `schedule.sessionSlots()`). Not enumerated control-by-control
here (out of scope of the nine surfaces); the interactive session-slot cap editor lives on the Home tab (`Home.tsx:642` →
`schedule.setSessionSlots`), and the same cap is editable from the Queue PolicyBar (§3).

## API reconciliation — `src/preload/api.d.ts`

`schedule` block (`api.d.ts:1776`), 26 members, each accounted for below.

| Member | Reached from Scheduler UI by |
| --- | --- |
| `setConfig` | §3 Start jobs, Pause above; §7 all four supervisor controls |
| `setSessionSlots` | §3 Up to N at once |
| `resetJob` | §5 reset to pending; §8a Re-fire; §8b Reset; §9 reset to pending |
| `runNow` | §8a Queue job; §8b Run now |
| `forceTick` | §3 Fire next batch now; status-banner action (manual policy) |
| `pause` | §1 Pause; §3 Pause |
| `resume` | §1 Resume, Retry now; §3 status-banner action (paused) |
| `rescan` | §3 Refresh |
| `clearQueue` | §4 Archive & clear queue… |
| `openFolder` | §4 footer folder |
| `readLog` | §5 view log →; §8b Last run log; §9 view log → (via RunLogViewer) |
| `writePrd` | §8a + New PRD |
| `listPrds` | §8a on mount / refresh after archive, retag, new |
| `health` | §6 wiring: `SP:123` (drives meter banner + Diagnostics) |
| `queueHealth` | §2 QueueHealthHeader poll |
| `lintQueue` | §6 rerun lint (via `getLintQueueCached`) |
| `archivePrds` | §8a Archive modal |
| `retagPrds` | §8a Retag modal |
| `adoptPrd` | §5 adopt PRD → |
| `setPrdDisposition` | §5 change disposition… |
| `getHistory` | §9 (mount fetch; no button) |
| `state`, `onState`, `onStall` | store wiring only: `state/scheduleState.ts:37/77/101` feeds every snapshot-driven surface; no control. `onState` also re-fires `health()` at `SP:124` |
| `sessionSlots` | read-only: `useSessionSlots()` (Machine pill, Home, footer); the Scheduler screen's own slot numbers come from the snapshot / `queueHealth` |

`supervisor` block (`api.d.ts:1830`): `getLog` → §7 (mount-on-focus + refresh).

### Not reachable from the Scheduler UI

| Member | Reason |
| --- | --- |
| `supervisor.tickNow` | Debug-only ("Used by e2e tests"). Only caller is the command-palette entry "Scheduler — Run supervisor probe now" (`components/CommandPalette.tsx:162`); no Scheduler-screen button. |
| `schedule.readPrd` | No caller in any Scheduler surface — PRD body view/edit goes through `useEditor` / `EditorView` (§8b). Its only renderer caller is the Epics workspace (`components/epics/EpicDetail.tsx:387`, line-count on PRD cards). |

### Deviations from the PRD's expected "not reachable" list

The PRD guessed `runNow`, `writePrd`, `listPrds`, `archivePrds`, `retagPrds`, `getHistory`, `sessionSlots` (and `tickNow`) were unreachable.
Source shows all except the two above are reachable and are mapped in §§3-9: `runNow`/`writePrd`/`listPrds`/`archivePrds`/`retagPrds` from the PRDs
sub-view (§8), `getHistory` from the History sub-view (§9), `sessionSlots` as a read-only poll via `useSessionSlots` (Machine pill, Home, footer).
`schedule.tickNow` does not exist; only `supervisor.tickNow` does.

### Behavioural findings for the redesign (no code changed)

- **"Queue job" does not queue that PRD** — `runNow()` takes no slug and fires every pending job (`PRDS:549`); the per-card label overstates it.
- **Select-all is dead code** — `toggleAllVisible` (`PRDS:224`) has no control.
- **Pause/Resume are duplicated** in the shell WindowStrip (§1) and the SchedulePanel status banner (§3); both call the same API. When paused, the strip shows Resume while the panel banner shows Resume via `status.action` too.
- **`resume()` is reused for "Retry now"** on launch-block banners — there is no per-persona retry API.
- **Concurrency cap is editable in two places** (Queue PolicyBar and Home tab), both → `setSessionSlots`.
- **History has no refresh** — data is a one-shot `getHistory()` on mount.
