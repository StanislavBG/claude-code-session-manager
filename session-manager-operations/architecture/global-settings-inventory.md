# Global settings inventory — ground truth

Read-only inventory. No code changes. Produced to seed a later "how should global
settings be managed" design thread, prompted by the dockview-workbench migration
(PRDs 778–780, 787, 788) turning screens into panels.

Every claim below is a direct file:line reference, verified by reading the source
(spot-checked 2026-07-30). Scope legend: **GLOBAL** = affects the whole app/window
regardless of which tab is active · **PER-TAB** = scoped to the currently active
tab/session · **PER-PANEL** = would need to move to per-panel-instance state once
dockview lets a screen type be mounted more than once.

---

## 1. Frame action buttons

### TabBar row — `src/renderer/components/TabBar.tsx`

| Control | file:line | What it controls | Scope |
|---|---|---|---|
| Tab-select (click pill) | `TabBar.tsx:73-85` (via `useTabDragReorder`'s `onActivate`, `TabBar.tsx:46-53`) → `setActive(tab.id)` (`useSessions`) | Which tab is active app-wide; triggers terminal-nav effect (`App.tsx:101-111`) | GLOBAL |
| Tab drag-to-reorder | `TabBar.tsx:46-53`, `reorderTab` (`useSessions`) | Tab display order | GLOBAL |
| Close-tab "×" | `TabBar.tsx:106-116`, `closeTab(t.id)` (`useSessions`) | Kills one tab's PTY/session | Targets one tab, but mutates the global tab list |
| Split-view toggle | `TabBar.tsx:122-134`, `onToggleSplitView` prop → `App.tsx:649` (`setSplitView(true)`), closed via Escape (`App.tsx:484-485`) or `SplitAgentBrowser`'s `onExit` (`App.tsx:635`) | Swaps entire window body to `<SplitAgentBrowser>` (`App.tsx:629-639`); gated on `canSplitView` (`TabBar.tsx:26`) | GLOBAL |
| App version label | `TabBar.tsx:136` | Display only, not a control | — |

### AlmanacSidebar — `src/renderer/components/layout/AlmanacSidebar.tsx`

| Control | file:line | What it controls | Scope |
|---|---|---|---|
| New-session button | rail `:274-281`, expanded `:322-330` → `onNewSession` prop → `App.tsx:167-173` (`handleNewSession`) → `useLayout.getState().openPanel('terminal')` + `createPickedSession()` | Adds a new tab, focuses the terminal panel window-wide | GLOBAL |
| Rail collapse/expand | `:282-291`, `:302-311` → `toggleRail` (`:125-131`) | Icon-only vs full sidebar | GLOBAL |
| Nav-group header toggles (Workspace/Configure/Tools) | `:344-363` (`NavGroupHeader`) → `toggleGroup(g)` (`:113-121`) | Which nav groups are folded | GLOBAL |
| Nav-item rows (Overview/Terminal/Editor/Settings/…) | `:373-416` (`NavRow`) → `onNavigate(item.key)` prop → `App.tsx:62-64` (`navigate`) → `useLayout.getState().openPanel(k)` | Routes the whole window's focused panel — single-window shell, no per-tab panel state | GLOBAL |
| Tool rows (Voice/Repoviz/Search) | `:418-452` (`ToolRow`) → same `onNavigate`/`openPanel` path | Same as nav-item rows | GLOBAL |
| Sidebar resize handle | `:246-254` (`role="separator"`, `startResize`/`resetWidth`) | Sidebar pixel width | GLOBAL |
| VoiceButton (mounted in `ProjectCaption`, expanded mode) | `:331-333` | See VoiceButton section below | PER-TAB (recording target) / GLOBAL (recording flag) |
| SidebarFooter model/recording display | `:454-491`, reads `findPreset(activeTab.presetId)` (`:459-467`) | Display only — "Claude · {model}" + recording dot, no `onClick` | PER-TAB (display) |

### AlmanacFooter chips — `src/renderer/components/layout/AlmanacFooter.tsx`

| Control | file:line | What it controls | Scope |
|---|---|---|---|
| Connected dot | `:67-74`, `onClick → onNavigate?.('settings')` | Nav to Settings panel; state from `useBilling().isConnected` (`:58`) | GLOBAL |
| 5h-usage pill | `:76-82`, `onClick → onNavigate?.('overview')` | Nav to Overview panel; reads `useBilling`/`getBillingData` (`:55-57`) | GLOBAL |
| Scheduler-paused pill (conditional) | `:84-97`, `onClick → onNavigate?.('scheduler')` | Nav to Scheduler panel; state from `useScheduleState` snapshot (`:31`) | GLOBAL |
| Active-tab label | `:99-104` (display only) | Shows `tab.label` + branch via `useBranch(tab?.cwd)` (`:32`) | PER-TAB (display) |
| Branch indicator | `:102` (`⌥{branch}`, display only) | — | PER-TAB (display) |
| Last-activity text | `:106` (display only), `useLiveTab(tab).lastEventAt` (`:28-29`) | — | PER-TAB (display) |
| Todos chip | `:108-115` → `TodoChip` (`:129-175`); `onToggle` (`:141`) flips local `todosOpen` state (`:41`) | Expand/collapse todos popover; data from `useLiveTab(tab)` (`:40`) | PER-TAB |
| App version label | `:119` (display only) | — | — |

### VoiceButton — `src/renderer/components/VoiceButton.tsx`

| Control | file:line | What it controls | Scope |
|---|---|---|---|
| Mic button | `:72-99` (`onClick` handler `:30-48`) | Branches: stop if recording; open wizard if armed; retry if in error/timeout gate; else `startRecording(tabId)` where `tabId = useSessions.getState().activeTabId` (`:46-47`) | **PER-TAB target** (STT routes to the active tab's PTY, `state/voice.ts:167,529`), but `isRecording` is a single **GLOBAL** boolean on `useVoice` — only one recording session app-wide, drives the global `RecordingStatus` banner (`App.tsx:634,648`) and window-title IPC (`App.tsx:431-433`) |
| TTSToggle | `VoiceButton.tsx:103-141` | Toggles `ttsEnabled` on `useVoice` (`state/voice.ts:770`) | **Not mounted in app chrome** — only mounted in `components/layout/VoiceModal.tsx:26` (Voice-panel screen content). Listed for completeness; GLOBAL flag, consumed per-active-tab via `useVoiceTTS(activeTabId)` (`App.tsx:135`) |

### BroadcastBar — `src/renderer/components/BroadcastBar.tsx`

Mounted conditionally at `App.tsx:664-672` (`focusedPanelId === 'terminal' && broadcastOpen`); opened via `toggleBroadcast` (`App.tsx:148-153`) or CommandPalette `'broadcast'` (`App.tsx:744-746`).

| Control | file:line | What it controls | Scope |
|---|---|---|---|
| "All tabs" checkbox | `:130-140`, `toggleAll` (`:98-102`) | Bulk-checks every tab in the broadcast list | GLOBAL selection, local `useState` |
| Per-tab checkboxes | `:147-153` | Which tabs receive the broadcast | PER-TAB |
| Prompt textarea | `:121-128`, local `useState` (`:11`) | Broadcast text | ephemeral |
| Cancel button | `:167-172` → `onClose` prop → `App.tsx:666` (`setBroadcastOpen(false)`) | Closes bar | GLOBAL chrome-visibility |
| Send button | `:173-179` → `send()` (`:63-83`), writes `prompt + '\r'` via `window.api.pty.write({tabId, data})` per checked tab (`:75`) | Fans the prompt out to N tabs simultaneously | GLOBAL action, ephemeral content |

### WatchersPopover — `src/renderer/components/WatchersPopover.tsx`

Mounted conditionally at `App.tsx:673-681` (`focusedPanelId === 'terminal' && activeTab && watchersOpen`), `tabId={activeTab.id}`; opened via `toggleWatchers` (`App.tsx:155-160`) or CommandPalette `'watchers'` (`App.tsx:747-749`).

| Control | file:line | What it controls | Scope |
|---|---|---|---|
| Close "×" | `:60` → `onClose` → `App.tsx:678` (`setWatchersOpen(false)`) | Closes popover | GLOBAL chrome-visibility |
| Label / command inputs | `:64-77`, local `useState` | Form fields | ephemeral |
| "Add" watcher | `:79-86` → `submit()` (`:36-46`) → `useWatchers.getState().add({...})` (`state/watchers.ts:69`) → IPC `window.api.watchers.add` | Starts a background shell watcher for `tabId` | **PER-TAB**, no disk persistence (deliberately ephemeral — see `src/main/watchers.cjs:1-8`: "No persistence across restarts") |
| "stop" (remove) | `:103-110` → `remove(w.watcherId)` (`state/watchers.ts:95`) → IPC `window.api.watchers.remove` | Kills a watcher | PER-TAB, same non-persistence |

### TerminalControls — `src/renderer/components/TerminalControls.tsx`

Not mounted by `App.tsx`/`layout/*.tsx` directly — rendered by `src/renderer/components/TerminalStage.tsx:48` (`{visible && <TerminalControls />}`), i.e. it overlays the terminal **panel**, one level removed from app shell chrome. Included per the AC's explicit ask.

| Control | file:line | What it controls | Scope |
|---|---|---|---|
| Gear button (popover trigger) | `:190-200`, local `useState` (`:160`) | Show/hide the settings popover | ephemeral |
| Theme swatches (Dark/Light/Paper) | `:210-224` → `update({theme: t})` (`:176-182`) → `saveTerminalSettings` (`:54-59`) | Terminal color theme | **GLOBAL** — broadcasts a `window` `CustomEvent('sm:terminal:settings')` (`:58`) consumed by every live xterm instance (`Terminal.tsx:68+`), i.e. changes ALL terminals at once, not just the active tab's |
| Font-size "−" | `:232-239`, `bumpFont(-1)` (`:184-187`) | Terminal font size | GLOBAL (same broadcast) |
| Font-size "reset" | `:240-245`, `update({fontSize: TERMINAL_FONT_DEFAULT})` | Terminal font size | GLOBAL |
| Font-size "+" | `:246-253`, `bumpFont(1)` | Terminal font size | GLOBAL |

### Model picker(s) — `src/renderer/lib/rawSessionModel.ts`

No model picker is rendered in `App.tsx` or `components/layout/*.tsx`. `rawSessionModel.ts` is a module-level singleton (`current` at `:26`, fan-out `listeners` set at `:27`), read/written via `getRawSessionModel()`/`setRawSessionModel()`/`useRawSessionModel()` hook (`:40-52`). Its only UI mount point is `src/renderer/components/tabs/SettingsAppPrefs.tsx:1,9` (Settings panel content, not chrome). Scope: **GLOBAL default** — used as the fallback model for brand-new raw sessions (`state/sessions.ts:85,223`), so it affects future tab creation app-wide, not any currently open tab.

`AlmanacSidebar.tsx`'s `SidebarFooter` (`:454-491`) *displays* the active tab's actual model (resolved via `findPreset(activeTab.presetId)`) — read-only, not a picker.

### CommandPalette trigger — `src/renderer/App.tsx`

Keyboard-only, no visible chrome button. `Cmd/Ctrl+K` toggles `paletteOpen` (`App.tsx:465-469`, listener installed `:442-509`); `Cmd/Ctrl+P` / `Cmd/Ctrl+Shift+F` route to `search` nav with `searchMode` (`App.tsx:470-481`); `Alt+1..5` activates a tab by index (`App.tsx:486-501` → `useSessions.getState().setActive`). All GLOBAL (window-level capture-phase `keydown`, `App.tsx:507-508`); `paletteOpen`/`searchMode` are plain `useState` (`App.tsx:53-54`), no persistence. The palette (`App.tsx:715-780`) dispatches to controls already inventoried above (`new-tab-pick`, `broadcast`, `watchers`, `reload-window`, etc.) — no new UI surface.

### Other App-level chrome (non-interactive, noted for completeness)

- `RecordingStatus` (`App.tsx:634,648`) — privacy banner, GLOBAL, tied to `isRecording` (see VoiceButton).
- `MicWizard` (`App.tsx:710`) — modal; lifecycle owned by `useVoice` (`wizardOpen`/`closeWizard`, `App.tsx:133-134`).
- `TourOverlay` (`App.tsx:711`) — first-run overlay, out of scope (full-screen, not chrome-embedded).
- `Toast` (`App.tsx:714`) — excluded per task scope (not a control).

---

## 2. Persisted settings surfaces

### 2a. localStorage keys — `grep -rn "localStorage\." src/renderer --include=*.ts --include=*.tsx`

| Key | Owner file(s) | Stores | Scope |
|---|---|---|---|
| `sm.updateCheck.v1.<version>.<YYYY-M-D>` | `src/renderer/lib/updateCheck.ts:13,50-54,59,77` | Cached npm-registry "latest version" result, keyed per version+UTC day | GLOBAL, self-partitioning |
| `sm.density` | `src/renderer/lib/useDensity.ts:5,11,34` | UI density (`compact`/`roomy`), toggles a body CSS class | GLOBAL |
| `sm.editorPrefs.v1` | `src/renderer/state/editorPrefs.ts:27,33,43` | Editor prefs: fontSize, wordWrap, minimap, theme, autosave, wideMeasure, assistantRail (hand-rolled persist, not zustand `persist` middleware) | GLOBAL |
| `sm.tour.completedAt` | `src/renderer/state/tour.ts:19,75,88,96` | First-run tour completion timestamp | GLOBAL |
| `sm.schedulerTab.subView` | `src/renderer/components/tabs/Scheduler.tsx:33,173,178` | Last-active Scheduler sub-tab (`queue`/`prds`/`history`) | scoped to Scheduler tab (single global value) |
| `sm.terminal.settings` | `src/renderer/components/TerminalControls.tsx:24,38,56` | `{theme, fontSize}` — see chrome table above | GLOBAL |
| `sm.history.budgetCapUsd` | `src/renderer/components/tabs/history/analytics/BudgetStrip.tsx:9,20,29` | Monthly spend budget cap (USD); explicitly "not scoped to the project facet" per in-code comment | GLOBAL |
| `sm.rawSessionModel` | `src/renderer/lib/rawSessionModel.ts:7,16,36` | Default model for new raw sessions | GLOBAL |
| `sm.projects.splitPct` | `src/renderer/components/tabs/ProjectsWorkspace.tsx:11,21,84,94` | File-tree/editor split-pane % in Projects workspace | scoped to Projects tab |
| `sm.projects.fileTreeCollapsed` | `src/renderer/components/tabs/ProjectsWorkspace.tsx:16,28,100` | Projects tab file-tree rail collapse | scoped to Projects tab |
| `sm.scheduler.queueFilter` | `src/renderer/components/SchedulePanel.tsx:23,32,45` | Last-used Queue status filter | scoped to Scheduler Queue panel |
| `sm.scheduler.hiddenCompletedSlugs` | `src/renderer/components/SchedulePanel.tsx:21,65,75` | Renderer-only "cleared" completed job slugs (underlying `queue.json` untouched) | scoped to Scheduler Queue panel |
| `sm.scheduler.focusedJobIndex` | `src/renderer/components/SchedulePanel.tsx:22,95,151,157,445` | Keyboard-nav focus index into job list | scoped to Scheduler Queue panel |
| `sm.learningPanel.collapsed` | `src/renderer/components/LearningPanel.tsx:5,9,23` | Collapsed/expanded inline help panel (migrated off a legacy per-tab format) | GLOBAL |
| `sm.fileTree.expanded:<cwd>` | `src/renderer/components/layout/FileTree.tsx:30,33,39` | Expanded folders in the file explorer | per-cwd (per project), capped at 500 entries |
| `sm.fileTree.showHidden` | `src/renderer/components/layout/FileTree.tsx:48,51,57` | Show/hide dotfiles in file explorer | GLOBAL (explicit in-code comment: "globally — it's a user preference") |
| `session-manager.quickopen.recent` | `src/renderer/components/modals/QuickOpenModal.tsx:141,160,244` | Last 8 recently opened files in Quick Open | GLOBAL |
| `sm.memoryTab.scope` | `src/renderer/components/tabs/Memory.tsx:27,39,42` | Active Memory sub-view (`workspace`/`subagent`) | scoped to Memory tab |
| `sm.history.analytics.measure` | `src/renderer/components/tabs/HistoryDashboard.tsx:20,27,57` | Selected History dashboard measure | scoped to History dashboard |
| `sm.history.analytics.range` | `src/renderer/components/tabs/HistoryDashboard.tsx:21,35,58` | Selected History dashboard date range | scoped to History dashboard |
| `sm.almanac.sidebarWidth` | `src/renderer/components/layout/AlmanacSidebar.tsx:51,58,158,167` | Sidebar drag width | GLOBAL |
| `sm.almanac.sidebarCollapsed` | `src/renderer/components/layout/AlmanacSidebar.tsx:66,70,128` | Sidebar rail collapse | GLOBAL |
| `sm.almanac.collapsedGroups` | `src/renderer/components/layout/AlmanacSidebar.tsx:78,83,117` | Folded nav-group headers | GLOBAL |

Verified by direct grep (not from the sub-agent report alone): `rawSessionModel.ts:7,16,36`; `AlmanacSidebar.tsx:51,58,66,70,78,128,158,167`; `TerminalControls.tsx:24,38,56`.

### 2b. Files under `~/.claude/session-manager/` written by `src/main` (`writeJson`/`writeJsonSync`/`writeTextAtomic`, all funneled through `validatePath`/`validateWrite` in `src/main/config.cjs:71,98,86-91,106-145`)

| File | Owner | Stores | Scope |
|---|---|---|---|
| `billing-cache.json` | `src/main/usage.cjs:107,146` | Cached Claude Code billing/usage totals | GLOBAL, single file |
| `scheduled-plans/queue.json` | `src/main/scheduler.cjs:271,560` | The scheduler's job queue (all projects) | GLOBAL, single file |
| `scheduled-plans/prds/<slug>.md` | write via `remote.writePrd` (`scheduler.cjs:3370`, called from `src/main/lib/prdCreate.cjs:140`); rename/edit via `config.writeTextAtomic` (`src/main/queueOps.cjs:421`) | Individual PRD bodies | one file per PRD, colocated in one global dir |
| `scheduled-plans/prds-archived/<ISO-ts>/<slug>.md` | `src/main/queueOps.cjs:45,220` (`fsp.rename`, not `writeJson`) | Archived/completed PRDs | per-PRD |
| `scheduled-plans/runs/<runId>/<slug>.meta.json` | `src/main/scheduler.cjs:269,1344,1366,1388,1537,1563` | Per-job-run execution metadata (exit code, timing, sessionId, error) | per job run |
| `scheduler-state.json` | `src/main/scheduler.cjs:272,486` (verified: `486` writes via `config.writeJsonSync`) | Global scheduler runtime state | GLOBAL, single file |
| `scheduler-heartbeat.log` | `src/main/scheduler.cjs:273,514` (`fs.appendFileSync`, not writeJson — noted for completeness) | Heartbeat/liveness log, size-rotated | GLOBAL, single file |
| `workbench-layout.json` | `src/main/layoutStore.cjs:23,48` (verified) | The Workbench's ONE system dockview layout (per in-code comment `layoutStore.cjs:1-13`) | GLOBAL, single file — **owned by PRD 788, out of scope here** |
| `memory-clusters/<workspace>.json` | `src/main/memoryAggregate.cjs:33,39,215` | Memory-clustering cache | one file per project workspace |
| `agent-memory/<agentId>.json` | `src/main/agentMemory.cjs:49,52,95` | Per-agent memory/state record | one file per agent id |
| `browser/history.json` | `src/main/browserView.cjs:34-35,64` | In-app browser tab URL/nav history | GLOBAL, single file |
| `browser/zoom.json` | `src/main/browserView.cjs:36,297` | In-app browser zoom factor | GLOBAL, single file |
| `browser-agent-api.json` (+ `.dev.json`/`.e2e.json`) | `src/main/browserAgentServer.cjs:47,58,61,126,133` | Local browser-agent HTTP server port+token (chmod 0600) | GLOBAL, mode-scoped |
| `admin-api.json` (+ `.dev.json`/`.e2e.json`) | `src/main/lib/localAdminHttp.cjs:41,53,56,118,125` | Local admin HTTP server port+token (chmod 0600) | GLOBAL, mode-scoped |
| `web-remote.json` | `src/main/webRemote.cjs:44-46,242` | Web-remote pairing/device config (chmod 0600) | GLOBAL, single file |
| `logs/remote-audit-<YYYYMMDD>.log` | `src/main/webRemote.cjs:47-49,250,253` | Web-remote audit log (`fs.appendFile`, not writeJson — noted for completeness) | GLOBAL, day-partitioned |
| `history-rollup.jsonl` | `src/main/lib/historyRollup.cjs:32,132` | Compacted history-run aggregates | GLOBAL, single JSONL file |

**`~/.claude/projects/<workspace>/memory/*.md`** — NOT under `~/.claude/session-manager/`. Written via `config.writeTextAtomic` (`src/main/memoryTool.cjs:145`), path built by `workspaceDir(workspace)` = `~/.claude/projects/<workspace>/memory` (`memoryTool.cjs:41-53`). Deliberately repoints at Claude Code's native auto-memory store, not a session-manager-owned directory. Per-workspace, per-entry files.

### 2c. `~/.config/session-manager/` — a second, distinct global-storage root (not under `~/.claude/session-manager/`)

| File | Owner | Stores |
|---|---|---|
| `otel.json` | `src/main/otelSettings.cjs:33-34,78` (verified) | OpenTelemetry export settings (chmod 0600) |
| `voice.json` | `src/main/voiceSettings.cjs:47-48,109` (verified) | Voice/dictation settings: device pref, wizard state, turn-detector mode (all subtrees of the same file, per in-code comments `voiceSettings.cjs:154,201,249`) |
| `tabs.json` | `src/main/sessionsStore.cjs:20-21,44` (verified) | Persisted renderer tab list `{tabs, activeTabId, savedAt}` — survives Electron restarts. Written by `sessions.ts:317` via `window.api.sessions.save` whenever tabs open/close/reorder/switch (see TabBar/AlmanacSidebar rows above) |

**Inconsistency flag:** `~/.claude/session-manager/` and `~/.config/session-manager/` are two separate top-level directories both used for "global session-manager state" with no apparent rule for which new files go where — see §4.

### 2d. Per-project (outside both global roots)

- **RCA/feedback markdown** — `src/main/lib/rcaFeedbackHook.cjs:171-189,299,323`. Prefers `<job.cwd>/session-manager-operations/feedback/`, falls back to this repo's own inbox (`SM_REPO_FEEDBACK_DIR`, `rcaFeedbackHook.cjs:38-39`) if the target project lacks the directory.
- **`projects-prefs.json`** — `src/renderer/state/projectsPrefs.ts:40,52,91,99,104,109,114,119,124,129` writes via `window.api.config.writeJson('~/.claude/session-manager/projects-prefs.json', ...)`. Stores Projects-tab UI prefs: pinned items, sort column/dir, recent-filter, remote/CLAUDE.md facet filters, pinned-only toggle, search text, external editor choice. **Not surfaced by the main-process grep above** because the write call originates in the renderer via the generic `config.writeJson` IPC bridge, not a dedicated `.cjs` file — flagged as its own settings surface.

### 2e. zustand store persistence audit

`grep -rn "persist(" ` + `grep -rln "zustand/middleware"` across `src/renderer`: **zero uses of zustand's official `persist` middleware anywhere in the renderer.** Two hand-rolled local functions are also named `persist` and are unrelated to the middleware:

- `src/renderer/state/editorPrefs.ts:42,70` — writes to `localStorage` key `sm.editorPrefs.v1` (see §2a).
- `src/renderer/state/projectsPrefs.ts:40,52,91,99,104,109,114,119,124,129` — writes to disk via IPC to `projects-prefs.json` (see §2d), not localStorage.

| Store | Scope | Persistence | Feed |
|---|---|---|---|
| `state/config.ts` (`useConfig`) | Global, keyed per absolute file path (`files: Record<string,FileState>`, `config.ts:30-31`) | None in-store — it's a cache of on-disk files via IPC (`config.ts:110,118,148,154,166,171`) | `config:changed` broadcast (`src/main/config.cjs:348`), consumed `config.ts:224-228` |
| `state/live.ts` (`useLive`) | **PER-TAB**, keyed by `tabId` (`tabs: Record<string,LiveTab>`, `live.ts:89`), refcounted (`live.ts:90-91`) | In-memory only, bounded ring buffers (`live.ts:219,258,274,337`) | `transcript:event:<tabId>` (main: `src/main/transcripts.cjs:119`; preload: `src/preload/index.cjs:125`), consumed `live.ts:136` |
| `state/voice.ts` (`useVoice`) | GLOBAL singleton (actions take `tabId` param, e.g. `startRecording(tabId)` `voice.ts:167,529`) | In-memory only; device/wizard/turn-detector prefs persist separately via IPC to `voice.json` (not this file) | `voice:hotkey`/`voice:hotkey-changed` (preload `index.cjs:166-174`), `window.api.voice.getDevicePref` (`voice.ts:711`) |
| `state/scheduleState.ts` (`useScheduleState`) | GLOBAL, single snapshot (`scheduleState.ts:21`) | In-memory/IPC-derived only | `window.api.schedule.state()` init (`scheduleState.ts:38`) + `onState` live sub (`scheduleState.ts:56`), backed by IPC channel `schedule:state` (main broadcast `src/main/scheduler.cjs:978`, invoke handler `scheduler.cjs:2890`) |
| `state/toast.ts` (`useToast`) | GLOBAL, single stack + history capped at 100 (`toast.ts:56,93`) | Purely in-memory, no persistence, no IPC | direct calls from other stores/components |

---

## 3. Per-tab vs global classification table

| Setting/control | Current scope | Correct or accidental? | Rationale |
|---|---|---|---|
| Active tab / tab order / tab list (`tabs.json`) | GLOBAL (single-window app) | **Correct** | One window, one tab strip — there is only one "active tab" concept to persist. |
| Sidebar width/collapse/group-fold (`sm.almanac.*`) | GLOBAL | **Correct** | One sidebar instance regardless of tab count; a per-tab sidebar layout would be surprising. |
| Terminal theme/font-size (`sm.terminal.settings`) | GLOBAL — broadcast via `window` CustomEvent to every live xterm | **Accidental-leaning** | Applies to ALL open terminals simultaneously even though `TerminalControls` is mounted per-panel (`TerminalStage.tsx:48`) and visually looks like it's adjusting "this terminal." Users adjusting one tab's font size get every tab's font size changed. Worth flagging for the workbench redesign since terminals will become independent panel instances. |
| Raw-session default model (`sm.rawSessionModel`) | GLOBAL (affects only *future* tab creation) | **Correct, but confusing** | It's a creation-time default, not a live per-tab override — reasonable to be global, but nothing in the UI distinguishes "default for new tabs" from "current tab's model" (see `SidebarFooter` which *displays* the per-tab model right next to where users might expect this to be a live picker). |
| Voice recording (`isRecording`) | GLOBAL flag, but `startRecording(tabId)` targets one tab's PTY | **Correct by necessity** | Only one physical microphone/STT pipeline can run at a time; the flag being global while the target is per-tab is the only coherent design, but it does mean recording auto-stops (or is blocked) when switching tabs mid-dictation — worth confirming that's the intended UX. |
| Watchers | PER-TAB, zero persistence | **Correct, deliberate** | Explicit in-code rationale (`watchers.cjs:1-8`): ephemeral by design, user re-adds after restart. |
| BroadcastBar tab-selection checkboxes | PER-TAB (which tabs receive the message) inside a GLOBAL modal (open/close) | **Correct** | The action is inherently cross-tab; per-tab selection state resetting each time the bar opens is reasonable. |
| Todos chip | PER-TAB (data), local open/closed state | **Correct** | Todos are a live per-session concept; footer surfaces the active tab's todos only. |
| Scheduler sub-view/filter/hidden-slugs/focus-index (`sm.scheduler.*`) | scoped to the Scheduler tab (single global value, not per-job) | **Correct** | There is exactly one Scheduler screen; no ambiguity today, but see §4 for the dockview-panel question. |
| Projects split%/file-tree-collapsed (`sm.projects.*`) | scoped to Projects tab (single global value) | **Correct today, PER-PANEL under dockview** | If the workbench ever allows two Projects panels open side-by-side (e.g. two different repos), a single localStorage key would make them fight over one split position — flag only, no redesign here. |
| File-tree expand state (`sm.fileTree.expanded:<cwd>`) | per-cwd | **Correct** | Already scoped correctly to the thing that varies (which project you're browsing), independent of tab count. |
| File-tree "show hidden" (`sm.fileTree.showHidden`) | GLOBAL (explicit in-code comment) | **Correct, and self-aware** | Code comment explicitly justifies the choice — the one case in this inventory where the author documented the scope decision at the point of use. |
| History dashboard measure/range (`sm.history.analytics.*`) | scoped to History tab | **Correct today** | Same per-panel caveat as Projects — would need instancing if multiple History panels ever coexist. |
| Memory tab scope (`sm.memoryTab.scope`) | scoped to Memory tab | **Correct** | Single Memory screen today. |
| Budget cap (`sm.history.budgetCapUsd`) | GLOBAL, explicit in-code comment ("not scoped to the project facet") | **Correct, deliberate** | Spend is a real-world monthly figure independent of which project you're viewing. |
| `workbench-layout.json` | GLOBAL, single file (per `layoutStore.cjs` comment: "the ONE system dockview layout") | **Correct, and PRD 788's explicit contract** | Out of scope for redesign here — the workbench chain already owns this. |
| `~/.claude/session-manager/` vs `~/.config/session-manager/` split | Neither global nor per-something — an unexplained **filesystem-location** inconsistency | **Accidental** | See §4. No code comment anywhere explains why `otel.json`/`voice.json`/`tabs.json` live under `~/.config/` while everything else (queue, billing, layout, browser, admin API, web-remote) lives under `~/.claude/session-manager/`. |
| `projects-prefs.json` write path | Global file, but the write call lives in renderer `state/projectsPrefs.ts`, not a dedicated main-process module like every other file in §2b | **Accidental (structural inconsistency)** | Every other `~/.claude/session-manager/*.json` file has an owning `.cjs` module with a `storePath()` helper; this one is written ad hoc via the generic `config.writeJson` IPC bridge directly from renderer state code. Not wrong, but breaks the pattern this file otherwise establishes. |

---

## 4. Inconsistencies & open questions

1. **Same concern (terminal appearance), one global switch, panel-shaped UI.** `TerminalControls.tsx` is mounted per-panel (`TerminalStage.tsx:48`, visually "this terminal's settings gear") but its theme/font-size writes are broadcast globally to every live xterm via a `window` `CustomEvent` (`TerminalControls.tsx:58`). Under the dockview migration, once multiple terminal panels can be open side-by-side, this mismatch between "looks per-panel" and "acts global" becomes more visible, not less.

2. **Two unexplained global-storage roots.** `~/.claude/session-manager/` (queue, billing, layout, browser, admin/browser-agent API tokens, web-remote config, history rollup, memory clusters, agent memory) vs `~/.config/session-manager/` (otel, voice, tabs). No code comment anywhere states the rule for which new global settings should go where. A new global setting added today has no canonical answer for "which directory."

3. **`projects-prefs.json` breaks the main-process module pattern.** Every other file under `~/.claude/session-manager/` is owned by a dedicated `.cjs` module (`layoutStore.cjs`, `sessionsStore.cjs`, `otelSettings.cjs`, `voiceSettings.cjs`, `webRemote.cjs`, `usage.cjs`, etc.) with an explicit `storePath()`. `projects-prefs.json` is instead written directly from renderer code (`state/projectsPrefs.ts`) through the generic config IPC bridge — the one persisted settings file with no main-process owner.

4. **Model selection has two disconnected surfaces.** `rawSessionModel.ts` (global, localStorage, "default model for new tabs," surfaced only in Settings → `SettingsAppPrefs.tsx`) and the per-tab preset's model (surfaced read-only in `AlmanacSidebar`'s `SidebarFooter`, `:454-467`) are two different concepts that could easily be conflated by a user — "change the model" intuitively reads as "change it for my current session," but the only UI control actually changes the default for *future* sessions.

5. **`sm.scheduler.hiddenCompletedSlugs` is a client-only illusion of state deletion.** The key (`SchedulePanel.tsx:21,65,75`) hides completed jobs from the UI without touching `queue.json` on disk — so "clearing" a completed job in the renderer is purely cosmetic and doesn't survive a `localStorage.clear()` or a different browser/window instance connecting to the same backend (e.g. web-remote). Worth confirming this cosmetic-only semantics is intended, since the wording ("cleared") suggests something more durable.

6. **TerminalControls is one layout level removed from "chrome."** The AC's implementation notes list `TerminalControls.tsx` alongside `App.tsx`'s direct chrome children (VoiceButton, BroadcastBar, WatchersPopover), but structurally it's mounted by `TerminalStage.tsx` (a panel-content component), not by `App.tsx` or `components/layout/*.tsx`. This isn't a bug, just a scope note: the "frame chrome" boundary already has one exception in practice, which the dockview migration will likely formalize (panel-owned toolbars vs. window-owned chrome).

7. **Watchers are the only genuinely-ephemeral per-tab setting with an explicit rationale; nothing else documents its ephemeral-vs-persistent choice.** Only two settings in this whole inventory carry an in-code comment explaining *why* their scope/persistence was chosen: `watchers.cjs:1-8` (ephemeral, user re-adds) and `FileTree.tsx`'s `sm.fileTree.showHidden` (global, "it's a user preference"). Every other setting's scope is implicit in where the code happens to live, not a documented decision — this is the core gap a future consolidation design would need to fill in.

8. **Broadcast/Watchers open-state (`broadcastOpen`/`watchersOpen`) live as `App.tsx` component `useState`, not in a store.** (`App.tsx:55,56`.) They're GLOBAL chrome-visibility toggles but structurally inconsistent with `paletteOpen`/`searchMode` which are also local `useState` in the same file (`App.tsx:53-54`) — none of these four are centralized in a store the way tab/voice/schedule state are, even though they're conceptually similar "is this overlay open" booleans. Not wrong, just notably ad hoc compared to the rest of the state architecture.
