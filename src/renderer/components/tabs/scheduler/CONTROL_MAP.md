# Scheduler screen — control → API map

> **Regenerated 2026-09-19 (PRD sched2a-density-audit-and-e2e) against the post-2A code.** §§1–7 describe the CURRENT screen
> (title/KPI/PLANS bands → plan bands of stage columns → footer band). The pre-2A components (`WindowStrip`, `QueueHealthHeader`,
> `PolicyBar`, FireStatus banner, `SchedulerSubTabs`, standalone `DiagnosticsSection`, the old footer row) are deleted; the pre-2A
> map is in git history at `cf9bf76`. §§8–10 (PRDs / History / Machine) are untouched by 2A. **Line numbers are omitted on
> purpose — grep the testid.** Every control below is asserted, with a mocked `window.api`, by
> `__tests__/SchedulerControlWiring.test.tsx` (the API-bearing ones) and `SchedulerTopBands.test.tsx` / `PlanGraph.test.tsx` /
> `PlanMinimap.test.tsx`.

Conventions: `SP` = `src/renderer/components/SchedulePanel.tsx`; `TB` = `tabs/scheduler/SchedulerTopBands.tsx`; other 2A
components are under `tabs/scheduler/`. `PRDS` = `tabs/plans/SchedulerPrdsView.tsx`; `HIST` = `tabs/plans/SchedulerHistoryView.tsx`.
`schedule.*` / `supervisor.*` = `window.api.schedule.*` / `window.api.supervisor.*` (`src/preload/api.d.ts`).
`toast.fromOutcome` shows the returned `ActionOutcome`; unmarked calls swallow the result. Behaviour is documentation-only here.

## 1. Title band (`TB`, testid `queue-health-header`)

| Control | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- |
| Refresh | `schedule.rescan().then(toast.fromOutcome)` | never | — |
| Pause | `schedule.pause()` | hidden when `snapshot.paused` | — |
| Resume | `schedule.resume()` | shown only when paused | — |
| Fire next batch | `schedule.forceTick().then(toast.fromOutcome)` | disabled when `pending === 0 && running === 0` | — |
| ⓘ verdict | none (title text from `schedule.queueHealth` verdict) | — | `scheduler-verdict-info` |
| Learning panel | own component; no scheduler API | — | — |

Read-only feeds: `schedule.queueHealth(scopeCwd)` on mount / scope change / every 15 s (`useQueueHealth` in `TB`) → state word, meta line, SLOTS cell.
`SchedulerAlerts` (under the title band): pause banner **Resume** → `schedule.resume()` (`pause-banner`); per-persona launch-block **Retry now**
→ `schedule.resume()` (`launch-block-banner`; there is no per-persona retry API); `launch-mitigation-banner` is informational.

## 2. KPI band (`TB`, testid `scheduler-kpi-band`) — six cells

`kpi-window` (Window used, from snapshot `utilization`; stale-poll ⓘ from `pollHealth`), `kpi-slots` (`queueHealth.slots` + `kpi-slot-pills`), `kpi-ready`,
`kpi-needs-you` (+ `kpi-needs-you-jump` — local scroll to the first needs-review row, no API), `kpi-done` (+ `kpi-done-spend`, `history.dashboard`), `kpi-concurrency`:

| Control | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- |
| Start-jobs `<select>` | `schedule.setConfig({ firePolicy })` | never | `kpi-fire-policy` |
| − / N / + stepper | `schedule.setSessionSlots(clamp 0..10)` | disabled when `effectiveConcurrency.source === 'env'` (`env` badge) | `kpi-concurrency-dec` / `-value` / `-inc` |
| Pause-above `<input>` % | `schedule.setConfig({ utilizationThreshold })` | only when `firePolicy === 'when-available'` | `kpi-threshold` |

## 3. PLANS toolbar (`TB`, testid `scheduler-plans-toolbar`)

| Control | Fires | testid |
| --- | --- | --- |
| Graph / List / Critical path segment | `onPlanMode(m)` + `onSubView('queue')` — local state | `plan-mode-graph` / `-list` / `-critical` |
| PRDs / History / Machine links | `onSubView(v)` — local state, persisted to `localStorage['sm.schedulerTab.subView']` | — |
| filter PRDs… input | `filterText` → SchedulePanel job filter (status chips are the in-panel `FilterBar`, persisted `sm.scheduler.queueFilter`) | `scheduler-filter-input` |

## 4. Counts strip + plan bands (`SP`, `PlanBand.tsx`)

| Control | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- |
| Clear completed | local: adds completed/failed slugs to `hiddenSlugs` + `localStorage['sm.scheduler.hiddenCompletedSlugs']`. **No API.** | only when a completed/skipped job is visible | — |
| N hidden · un-hide | local: clears `hiddenSlugs` | only when N > 0 | — |
| Archive & clear queue… | `window.confirm` → `schedule.clearQueue()`; `!r.ok` → toast | disabled when every job is running | — |
| Plan caret | local expand/collapse (ACTIVE/QUEUED open, DONE/DRAFT collapsed by default) | never | `plan-toggle` |
| Plan action: ACTIVE **Pause plan** | `schedule.pause()` — **machine-wide** (no per-plan pause exists) | — | `plan-action` |
| Plan action: QUEUED **Run now** | `schedule.forceTick()` — **machine-wide**, not this plan | — | `plan-action` |
| Plan action: DONE **View run** | `RunLogViewer` → `schedule.readLog(runId, slug)` of the plan's latest finished row | only when a row has a `runId` | `plan-action` |
| Plan action: DRAFT **Schedule…** | `setPendingPrdSlug` + `subView='prds'` (PRDs view has no per-Epic filter) | — | `plan-action` |
| WHOLE GRAPH dot strip + brush (ACTIVE plans) | local stage-window scroll | — | `plan-minimap`, `-dots`, `-brush`, `-range` |
| Running / Blockers jumps | local stage-window jump | disabled when no such stage | `minimap-running` / `minimap-blockers` |
| Stage footer `+N done/blocked/in stage ▾` | local expand | when the stage has overflow | `stage-footer` |
| FURTHER STAGES row | local scroll to that stage | — | `further-stage-row` |
| Stage `Retry #N` | `schedule.resetJob(slug)` | attention stages only | `stage-retry` |
| Stage `Review #N` | `openPromptSession(plan.epicId)` — authoring Epic, never mints work | — | `stage-review` |
| List-mode `N more completed` / `un-hide` | local | `collapsedCount > 0` (List mode only) | — |
| Epic section header (List mode) | local expand | never | `backlog-epic-section`, `backlog-epic-label` |

`role=list` container `aria-label="Job queue"` with `[data-job-row]` buttons and ArrowUp/ArrowDown handling is unchanged and covers Graph, List and Critical path; aria-live announcements unchanged.

## 5. PRD row detail (`PrdRow.tsx` `PrdDetail`; List mode `JobRow.tsx` keeps the same block)

Opened by clicking a row. Same calls in both modes.

| Control | Fires | Disabled / hidden | testid |
| --- | --- | --- | --- |
| view epic → | `openPromptSession(id)` — no API | only when the job's Epic resolves | `job-row-prompt-session-link` |
| view log → | `RunLogViewer` → `schedule.readLog(runId, slug)` | only when `job.runId` | — |
| adopt PRD → | `schedule.adoptPrd(slug).then(toast.fromOutcome)` | only when `quarantined` | `job-row-adopt-prd` |
| reset to pending → | `schedule.resetJob(slug)` | status not pending / running / quarantined | — |
| change disposition… `<select>` | `schedule.setPrdDisposition({ slug, cwd, disposition, dependsOn }).then(toast.fromOutcome)` | `job.disposition` set and status pending/quarantined; `DispositionControl.tsx` | `job-row-disposition-control` |

Critical path mode (`CriticalPathColumn.tsx`) renders the same `PrdRow`s (testids `critical-path`, `critical-entry`, `critical-est`, `critical-others`); no extra API.

## 6. Footer band (`SchedulerFooter.tsx`, testid `scheduler-footer`)

| Control | Fires | testid |
| --- | --- | --- |
| ⓘ | local expand of the detail block (booted / last poll / retry / cached reset / pids / per-PRD lint findings) | `footer-info`, `footer-detail` |
| rerun lint | `getLintQueueCached({ fresh: true })` → `schedule.lintQueue()` | `footer-rerun-lint` |
| supervisor | `SP` `setPanelView('supervisor')` → SupervisorPanel | `footer-supervisor` |
| folder | `schedule.openFolder()` | `footer-folder` |

Read-only feeds: `schedule.health()` on mount and every `schedule.onState` event (`SP`) → poll-failure count + meter-rate-limited banner (dismiss = local);
`lintQueue` (cached) on mount / job-count change → lint counts. Reset countdown + last run come from the snapshot.

## 7. SupervisorPanel (`SupervisorPanel.tsx`; opened by the footer `supervisor` link)

| Control | Fires |
| --- | --- |
| ← queue | `onBack` → `setPanelView('queue')` |
| refresh | `supervisor.getLog().then(setLog)` (also auto-fetched on panel focus) |
| enabled / interval min / probes / stale min | `schedule.setConfig({ supervisor: { enabled \| intervalMinutes \| maxConcurrentProbes \| probeStaleThresholdMinutes } })` |
| probe log rows | read-only, `supervisor.getLog()` |

First-run guide (`FirstRunGuide.tsx`, when the scope has no jobs): **Go to Sessions →** → `navigate?.('terminal')`.

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
`schedule.setSessionSlots`), and the same cap is editable from the Queue CONCURRENCY KPI cell (§2).

## API reconciliation — `src/preload/api.d.ts`

Re-derived 2026-09-19 from the `schedule:` block (26 members) and `supervisor:` block (2 members). Every member is either mapped to a live
control or listed with a reason. **No member reachable before 2A lost its route** (checked against the pre-2A map at `cf9bf76`).

| Member | Reached from the Scheduler UI by |
| --- | --- |
| `setConfig` | §2 Start jobs, Pause above; §7 the four supervisor controls |
| `setSessionSlots` | §2 stepper |
| `resetJob` | §4 stage Retry; §5 reset to pending; §8a Re-fire; §8b Reset; §9 reset to pending |
| `runNow` | §8a Queue job; §8b Run now (PRDs sub-view) |
| `forceTick` | §1 Fire next batch; §4 QUEUED Run now |
| `pause` | §1 Pause; §4 ACTIVE Pause plan |
| `resume` | §1 Resume; §1 pause banner + Retry now |
| `rescan` | §1 Refresh |
| `clearQueue` | §4 Archive & clear queue… |
| `openFolder` | §6 folder |
| `readLog` | §4 DONE View run; §5 view log →; §8b; §9 (via RunLogViewer) |
| `writePrd` / `listPrds` / `archivePrds` / `retagPrds` | §8a (PRDs sub-view) |
| `health` | §6 feed (`SP`) |
| `queueHealth` | §1 feed (`useQueueHealth`) |
| `lintQueue` | §6 rerun lint (via `getLintQueueCached`) |
| `adoptPrd` | §5 adopt PRD → |
| `setPrdDisposition` | §5 change disposition… |
| `getHistory` | §9 (mount fetch) |
| `state`, `onState`, `onStall` | store wiring only (`state/scheduleState.ts`); `onState` also re-fires `health()` |
| `sessionSlots` | read-only: `useSessionSlots()` (Machine pill, Home) |
| `supervisor.getLog` | §7 |

### Not reachable from the Scheduler UI

| Member | Reason |
| --- | --- |
| `supervisor.tickNow` | Debug-only ("Used by e2e tests"). Only caller: command-palette entry "Scheduler — Run supervisor probe now" (`components/CommandPalette.tsx`). Unreachable before 2A as well. |
| `schedule.readPrd` | No Scheduler-surface caller — PRD body view/edit goes through `useEditor` / `EditorView` (§8b). Only renderer caller is the Epics workspace (`components/epics/EpicDetail.tsx`). Unreachable before 2A as well. |

### Known gaps carried forward (no code changed by 2A)

- **No per-plan pause / run API.** The plan header's `Pause plan` → `schedule.pause()` and `Run now` → `schedule.forceTick()` are machine-wide; the button titles say so.
- **"Queue job" (PRDs sub-view) does not queue that PRD** — `runNow()` takes no slug and fires every pending job.
- **Select-all is dead code** in the PRDs view (`toggleAllVisible` has no control).
- **`resume()` is reused for "Retry now"** on launch-block banners — no per-persona retry API.
- **History has no refresh** — one-shot `getHistory()` on mount.
