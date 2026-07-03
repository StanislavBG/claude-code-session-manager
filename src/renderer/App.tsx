import { useCallback, useEffect, useRef, useState } from 'react'
import { TabBar } from './components/TabBar'
import { type NavKey } from './components/LeftNav'
import { AlmanacSidebar } from './components/layout/AlmanacSidebar'
import { AlmanacFooter } from './components/layout/AlmanacFooter'
import { MainPane } from './components/MainPane'
import { type SearchMode } from './components/modals/SearchModal'
import { RecordingStatus } from './components/RecordingStatus'
import { MicWizard } from './components/MicWizard'
import { CommandPalette, type Command } from './components/CommandPalette'
import { SimpleShell } from './components/SimpleShell'
import { Toast } from './components/ui/Toast'
import { SuperAgentStatusBar } from './components/layout/SuperAgentStatusBar'
import { OrchestratorStatusPanel } from './components/layout/OrchestratorStatusPanel'
import { installSuperAgentListener } from './state/superagent'
import { TourOverlay } from './components/TourOverlay'
import { useTour, hasCompletedTour } from './state/tour'
import { toast } from './state/toast'
import { installConfigChangeListener } from './state/config'
import { installMonacoSchemas } from './components/ui/JsonEditor'
import { useSessions, hydrateSessions } from './state/sessions'
import { useEditor } from './state/editor'
import { useWatchers } from './state/watchers'
import { startBillingPolling } from './state/billing'
import { startTeamsPolling } from './state/teams'
import { startSchedulePolling } from './state/scheduleState'
import { DEFAULT_PRESETS, renderCommand, resolvePresetCwd } from './lib/presets'
import { createPickedSession } from './lib/createPickedSession'
import { useVoiceTTS } from './lib/useVoiceTTS'
import { useVoice, type HotkeyMode } from './state/voice'
import { isRecognitionSupported } from './lib/speechRecognition'
import { useDensity } from './lib/useDensity'
import { log } from './lib/logger'

// Module-scope once-flag for the unsupported warning. Survives StrictMode
// double-effect; resets only on full reload.
let unsupportedLogged = false

// v0.13.1 — every nav item is a full page; no more App-level modal overlays.
// SCREEN_KEYS lists what MainPane can render. (Cmd+P / Cmd+Shift+F still
// trigger keyboard nav to the 'search' screen — in Files and Content mode
// respectively — they just no longer mount as overlays.)
const SCREEN_KEYS = new Set<NavKey>([
  // Workspace
  'overview',
  'terminal',
  'subagents',
  'scheduler',
  'prompts',
  'history',
  'usage',
  // Configure
  'skills',
  'plugins',
  'mcp',
  'hooks',
  'keybindings',
  'doc-editor',
  'memory',
  'projects',
  'system-prompt',
  'permissions',
  'settings',
  'remote',
  // Tools (promoted from modal in v0.13.1)
  'voice',
  'repoviz',
  'search',
  // In-app file editor (Files sidebar / terminal links route here).
  'editor',
])

export function App() {
  // Subscribe to the density singleton at the app root so its module loads and
  // applies the `density-compact` body class from persisted localStorage on
  // every boot. Without a caller the hook is dead code and the class is never
  // applied (the LeftNav-footer toggle that used to call it was dropped).
  useDensity()
  const [activeNav, setActiveNav] = useState<NavKey>('overview')
  // `--simple` launch flag: null until resolved, then true → SimpleShell.
  const [simpleMode, setSimpleMode] = useState<boolean | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [searchMode, setSearchMode] = useState<SearchMode>('files')
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [watchersOpen, setWatchersOpen] = useState(false)

  // Every NavKey routes to MainPane. Used by CommandPalette nav:* entries,
  // AlmanacSidebar, and the Cmd-P / Cmd-Shift-F keyboard shortcuts.
  const navigate = useCallback((k: NavKey) => {
    if (SCREEN_KEYS.has(k)) {
      setActiveNav(k)
    }
  }, [])

  // Open a file in the main-space Editor scene and route there. Used by the
  // Files sidebar; terminal file-links reach the same place via the
  // 'sm:open-editor' event below (Terminal has no `navigate` of its own).
  const openFileInApp = useCallback((path: string) => {
    useEditor.getState().openFile(path)
    navigate('editor')
  }, [navigate])

  useEffect(() => {
    const h = () => navigate('editor')
    window.addEventListener('sm:open-editor', h)
    return () => window.removeEventListener('sm:open-editor', h)
  }, [navigate])
  const activeTabId = useSessions((s) => s.activeTabId)
  const tabs = useSessions((s) => s.tabs)

  // QoL: switching the active session tab lands you on THAT project's terminal —
  // each tab is primarily a terminal, so a tab switch is a project switch. Fires
  // ONLY on a pure switch between already-open tabs: the active tab changed, the
  // tab SET did not (no open/close), the newly-active tab already existed, and
  // the previously-active tab still exists. Opening/closing a tab also reassigns
  // activeTabId, but their initiators set the nav themselves, so those must
  // not be hijacked to terminal.
  // Tracking the id SET — refreshed on every tab change, not a count sampled
  // only when activeTabId moves — keeps the discriminator correct even when a
  // background tab open/close doesn't move the active tab.
  const prevActiveTabRef = useRef<string | null>(activeTabId)
  const prevTabIdsRef = useRef<Set<string>>(new Set(tabs.map((t) => t.id)))
  useEffect(() => {
    const prevActive = prevActiveTabRef.current
    const prevIds = prevTabIdsRef.current
    const curIds = new Set(tabs.map((t) => t.id))
    prevActiveTabRef.current = activeTabId
    prevTabIdsRef.current = curIds
    const isPureSwitch =
      prevActive !== null && activeTabId !== null && activeTabId !== prevActive &&
      curIds.size === prevIds.size && prevIds.has(activeTabId) && curIds.has(prevActive)
    if (isPureSwitch) setActiveNav('terminal')
  }, [activeTabId, tabs])

  const isRecording = useVoice((s) => s.isRecording)
  const wizardOpen = useVoice((s) => s.wizardOpen)
  const closeWizard = useVoice((s) => s.closeWizard)
  useVoiceTTS(activeTabId)

  const restartActiveTab = useCallback(() => {
    const { activeTabId, restartTab } = useSessions.getState()
    if (activeTabId) restartTab(activeTabId)
  }, [])

  const rebootApp = useCallback(() => {
    window.api.app.rebootApp()
  }, [])

  // Toggling open switches to terminal nav so the popover/bar (rendered in
  // MainPane and gated on active === 'terminal') is actually visible.
  const toggleBroadcast = useCallback(() => {
    setBroadcastOpen((prev) => {
      if (!prev) setActiveNav('terminal')
      return !prev
    })
  }, [])

  const toggleWatchers = useCallback(() => {
    setWatchersOpen((prev) => {
      if (!prev) setActiveNav('terminal')
      return !prev
    })
  }, [])

  // F1: ref'd so the hotkey listener (mount-once) sees fresh values.
  const activeTabIdRef = useRef<string | null>(activeTabId)
  activeTabIdRef.current = activeTabId
  const hotkeyModeRef = useRef<HotkeyMode>('hold')

  const handleNewSession = useCallback(() => {
    setActiveNav('terminal')
    createPickedSession().catch((e) => {
      console.error('[App] new session failed:', e)
      toast.error('Could not start new session. Is the claude CLI on PATH?')
    })
  }, [])

  // Eager preload of the speech model + permission subscription.
  // Lifted here from VoiceButton so the model warms even if the user never
  // mounts the mic UI, and so the gate's permissionState is fresh on first
  // click. initModel() and the permission listener are both idempotent under
  // StrictMode / HMR remount; unsupported is logged at most once per session.
  useEffect(() => {
    if (!isRecognitionSupported()) {
      if (!unsupportedLogged) {
        log.warn('voice', 'mic.gate.unsupported')
        unsupportedLogged = true
      }
      return
    }
    useVoice.getState().initModel()

    let permStatus: PermissionStatus | null = null
    let cancelled = false
    const onChange = () => {
      if (!permStatus) return
      const p = permStatus.state as 'granted' | 'denied' | 'prompt'
      useVoice.getState().setPermissionState(p)
    }
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      navigator.permissions
        // The Permissions API name 'microphone' is not in lib.dom.d.ts everywhere.
        .query({ name: 'microphone' as PermissionName })
        .then((status) => {
          if (cancelled) return
          permStatus = status
          useVoice.getState().setPermissionState(status.state as 'granted' | 'denied' | 'prompt')
          // Only attach the listener if cleanup hasn't already run; without
          // this guard, a StrictMode/HMR remount can leak a listener that
          // resolves after the effect's cleanup.
          status.addEventListener('change', onChange)
        })
        .catch((err) => {
          log.warn('voice', 'permission query unsupported', { error: err?.message })
        })
    }
    return () => {
      cancelled = true
      if (permStatus) permStatus.removeEventListener('change', onChange)
    }
  }, [])

  useEffect(() => {
    const preset = DEFAULT_PRESETS[0] // sm-dangerous: claude --dangerously-skip-permissions

    // Spawn a live (non-dormant) tab — used only by simple mode.
    const spawnLiveTabInCwd = (cwd: string) => {
      if (!cwd || useSessions.getState().tabs.length > 0) return
      const id = crypto.randomUUID()
      const startupCommand = renderCommand(preset, { sessionId: id, cwd })
      useSessions.setState((s) => ({
        tabs: [
          ...s.tabs,
          {
            id,
            claudeSessionId: id,
            label: cwd.split('/').filter(Boolean).pop() || cwd,
            cwd,
            pid: null,
            status: 'spawning' as const,
            exitCode: null,
            startupCommand,
            presetId: preset.id,
            generation: 0,
          },
        ],
        activeTabId: id,
      }))
    }

    // Spawn a dormant tab for the empty-cockpit fallback in normal mode.
    // No PTY or claude process until wakeTab is called.
    const spawnDormantTabInCwd = (cwd: string) => {
      if (!cwd || useSessions.getState().tabs.length > 0) return
      const id = crypto.randomUUID()
      useSessions.setState((s) => ({
        tabs: [
          ...s.tabs,
          {
            id,
            claudeSessionId: id,
            label: cwd.split('/').filter(Boolean).pop() || cwd,
            cwd,
            pid: null,
            status: 'dormant' as const,
            exitCode: null,
            startupCommand: null,
            presetId: preset.id,
            generation: 0,
          },
        ],
        activeTabId: id,
      }))
    }

    // `--simple`: boot one fresh skip-perms session in the launch dir, skip
    // hydration (no restored multi-tabs in the chrome-free shell).
    window.api.app
      .launchMode()
      .then(({ simple, cwd }) => {
        if (simple) {
          setSimpleMode(true)
          spawnLiveTabInCwd(cwd)
          return
        }
        setSimpleMode(false)
        // Normal boot: hydrate persisted tabs in dormant state (no PTY spawned).
        // If nothing was persisted, fall through to the dormant auto-spawn path.
        hydrateSessions().then(() => {
          if (useSessions.getState().tabs.length > 0) return
          resolvePresetCwd(preset)
            .then((cwd) => spawnDormantTabInCwd(cwd || ''))
            .catch((e) => {
              console.warn('[App] failed to create initial tab:', e)
              toast.error('Failed to create initial tab. Is the claude CLI on PATH?')
            })
        })
      })
      .catch(() => {
        // launchMode IPC failed — degrade to normal boot.
        setSimpleMode(false)
        hydrateSessions().then(() => {
          if (useSessions.getState().tabs.length > 0) return
          resolvePresetCwd(preset).then((cwd) => spawnDormantTabInCwd(cwd || '')).catch(() => {})
        })
      })

    // Menu → New Session (Ctrl+N): pick a directory and open claude there.
    const offNewSession = window.api.app.onNewSession(() => {
      createPickedSession().catch((e) => {
        console.error('[App] new-session from menu failed:', e)
        toast.error('Could not start new session. Is the claude CLI on PATH?')
      })
    })

    // Menu → Reboot Session: kill active tab's PTY, respawn with fresh session.
    const offReboot = window.api.app.onRebootSession(() => {
      const { activeTabId } = useSessions.getState()
      if (activeTabId) useSessions.getState().restartTab(activeTabId)
    })

    useWatchers.getState().init()
    const offSuperagent = installSuperAgentListener()

    // Singleton pollers — replace per-component timers in Overview,
    // SchedulePanel, TeamsCard, etc.
    startBillingPolling()
    startTeamsPolling()
    startSchedulePolling()

    // Boot diagnostics (v0.10.1) — surface bad startup state as a toast.
    // Otherwise the data only lives in the boot-fail log file no one reads.
    window.api.app.claudeBinStatus().then((r) => {
      if (!r.foundOnDisk) {
        toast.warn(
          'Claude binary not found at any known path — sessions will rely on $PATH and may fail to spawn. Install via `npm i -g @anthropic-ai/claude-code` if spawn fails.',
        )
      }
    }).catch(() => { /* main-process churn during boot; ignore */ })

    window.api.app.homeSelfCheck().then((r) => {
      if (!r.ok) {
        toast.error(
          `Home-directory self-check failed: ${r.error ?? 'unknown'}. Session spawns will reject every cwd. Likely a symlinked /Users on macOS.`,
        )
      }
    }).catch(() => { /* ignore */ })

    const off = installConfigChangeListener()
    installMonacoSchemas([
      {
        uri: 'https://json.schemastore.org/claude-code-settings.json',
        fileMatch: ['**/settings.json', '**/settings.local.json'],
      },
      {
        uri: 'https://json.schemastore.org/claude-code-keybindings.json',
        fileMatch: ['**/keybindings.json'],
      },
    ]).catch((e) => console.warn('[monaco] schema install failed:', e))

    // F1 push-to-talk: fetch initial config + subscribe to hotkey events.
    // Mode is read off a ref so the listener (registered once) sees fresh
    // mode after a config change.
    window.api.voice.getHotkeyConfig()
      .then((cfg) => { hotkeyModeRef.current = cfg.mode })
      .catch((e) => log.warn('voice-hotkey', 'getHotkeyConfig failed', { error: String(e) }))

    const offCfg = window.api.voice.onHotkeyConfigChanged((cfg) => {
      hotkeyModeRef.current = cfg.mode
    })

    const offHotkey = window.api.voice.onHotkey(({ phase, source }) => {
      useVoice.getState().armHotkey({
        phase,
        source,
        mode: hotkeyModeRef.current,
        tabId: activeTabIdRef.current,
      })
    })

    // F1: window-destroyed terminal transition.
    const onBeforeUnload = () => useVoice.getState().destroyHotkey()
    window.addEventListener('beforeunload', onBeforeUnload)

    // F5: single navigator.mediaDevices.devicechange listener for the whole
    // app. Picker re-enumerates via a custom 'mic-device-change' event
    // (so it doesn't double-bind). If the active device vanishes mid-
    // recording, we stop and surface an error — never auto-restart.
    const onDeviceChange = async () => {
      // Best-effort: notify the picker first so its visible list refreshes.
      window.dispatchEvent(new Event('mic-device-change'))
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return
        const list = await navigator.mediaDevices.enumerateDevices()
        const inputs = list.filter((d) => d.kind === 'audioinput')
        const v = useVoice.getState()
        if (!v.isRecording) return

        // Read the current persisted device pref. If it had a non-null id
        // and that id is no longer present, stop recording and surface.
        // The label-rebind path is intentionally not run here — that
        // belongs to the next start, not a hot mid-recording swap.
        let pref: { selectedDeviceId: string | null; selectedLabel: string | null } | null = null
        try { pref = await window.api.voice.getDevicePref() } catch { /* */ }
        if (!pref || !pref.selectedDeviceId) return
        const stillThere = inputs.some((d) => d.deviceId === pref!.selectedDeviceId)
        if (stillThere) return

        log.warn('voice', 'device-vanished mid-recording; stopping', {
          deviceIdPrefix: pref.selectedDeviceId.slice(0, 8),
        })
        v.stopRecording()
        useVoice.setState({
          error: 'Microphone disconnected',
          errorKind: 'recording',
        })
      } catch (e: unknown) {
        log.warn('voice', 'devicechange handler failed', { error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    }

    return () => {
      off(); offNewSession(); offReboot(); offCfg(); offHotkey(); offSuperagent()
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
      }
    }
  }, [])

  // F1 privacy invariant: window-title prefix while recording.
  useEffect(() => {
    try { window.api.voice.setRecording(isRecording) } catch { /* preload not ready */ }
  }, [isRecording])

  // Item 13 — Cmd-K / Ctrl-K opens the global command palette. Toggle so a
  // second press closes the palette (Escape inside the palette also closes).
  // Listener is attached at the App level (not via Mousetrap) because Monaco
  // editor instances install their own key handlers — we rely on bubble-phase
  // ordering: Monaco's command palette consumes Cmd-K when an editor is
  // focused, leaving the global one alone. Confirmed acceptable in research-04
  // §1.
  useEffect(() => {
    const skipForRealInput = (e: KeyboardEvent): boolean => {
      // Don't hijack when Monaco / non-xterm text inputs are focused —
      // Monaco wires its own shortcuts and typing in an input feels weird
      // if the binding steals it. xterm's hidden helper-textarea is NOT a
      // "real" input — terminals claim focus at boot, so excluding it
      // would leave these shortcuts unreachable in the most common state.
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase() ?? ''
      const isXtermHelper = target?.classList?.contains('xterm-helper-textarea') ?? false
      if ((tag === 'input' || tag === 'textarea') && !isXtermHelper) return true
      if (target?.closest('.monaco-editor')) return true
      return false
    }

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        if (skipForRealInput(e)) return
        e.preventDefault()
        e.stopPropagation()
        setPaletteOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        if (skipForRealInput(e)) return
        e.preventDefault()
        e.stopPropagation()
        setSearchMode('files')
        navigate('search')
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (skipForRealInput(e)) return
        e.preventDefault()
        e.stopPropagation()
        setSearchMode('content')
        navigate('search')
      } else if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false)
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        // Alt+1..Alt+5 — activate tab at index 0..4. e.code is layout-stable
        // (e.key is the alt-modified char on some non-US layouts). Capture
        // phase + preventDefault is required because xterm would otherwise
        // forward "\x1bN" to the PTY as an ESC-prefixed key.
        const m = /^Digit([1-5])$/.exec(e.code)
        if (!m) return
        if (skipForRealInput(e)) return
        const idx = parseInt(m[1], 10) - 1
        const { tabs, setActive } = useSessions.getState()
        const target = tabs[idx]
        if (!target) return
        e.preventDefault()
        e.stopPropagation()
        setActive(target.id)
      }
    }
    // Capture phase: xterm.js consumes shortcuts on the terminal textarea
    // before bubble-phase listeners on window can see them. By registering
    // on capture we intercept BEFORE xterm — the early-return for input/
    // textarea keeps other shortcuts (typing) from being affected.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [paletteOpen])

  // F8 — read persisted turn-detector settings on mount, seed the store, and
  // (when opted-in and not in dictation mode) spawn the turn-detector worker
  // so its status messages drive `turnDetectorState`. The worker is a stub in
  // MVP that posts `load_failed` immediately — that's intentional. The host
  // exercises the entire fallback path (load_failed → pure-VAD) end-to-end so
  // the follow-up that drops in real ORT inference doesn't have to re-wire
  // lifecycle plumbing.
  useEffect(() => {
    let cancelled = false
    let tdWorker: Worker | null = null
    ;(async () => {
      try {
        const td = await window.api.voice.getTurnDetector?.()
        if (cancelled || !td) return
        useVoice.setState({
          turnDetectorMode: td.mode,
          turnDetectorState: 'disabled',
        })
        if (td.mode === 'off') return
        log.info('voice-turn', 'mount.opted-in', { mode: td.mode })
        // Re-check cancelled between the await and the spawn: a fast
        // unmount can resolve the IPC race after our earlier `cancelled`
        // gate but before the Worker is created, leaving a leaked worker
        // that never gets terminated.
        if (cancelled) return
        // Spawn the turn-detector worker. Vite handles the bundling via
        // `new URL(...) + type:'module'` per its Worker convention.
        tdWorker = new Worker(
          new URL('./lib/turnDetectorWorker.ts', import.meta.url),
          { type: 'module' },
        )
        tdWorker.addEventListener('message', (e: MessageEvent) => {
          const msg = e.data
          if (!msg || typeof msg !== 'object') return
          if (msg.type === 'status') {
            const status = msg.status as 'loading' | 'ready' | 'load_failed' | 'runtime_error'
            // Map the worker's status enum onto the store's TurnDetectorState.
            // 'loading' is an in-flight signal we don't track; 'ready' becomes
            // 'ok'; 'load_failed' / 'runtime_error' route as-is. The store's
            // setter logs each transition.
            if (status === 'ready') {
              useVoice.getState().setTurnDetectorRuntimeState('ok')
            } else if (status === 'load_failed' || status === 'runtime_error') {
              useVoice.getState().setTurnDetectorRuntimeState(status)
            }
          }
        })
        tdWorker.addEventListener('error', (e: ErrorEvent) => {
          log.error('voice-turn', 'turn-detector worker error', {
            message: e.message,
          })
          useVoice.getState().setTurnDetectorRuntimeState('runtime_error')
        })
        // Trigger init. Stub responds load_failed; once the follow-up lands
        // real ORT, this same message kicks off model download + warmup.
        tdWorker.postMessage({ type: 'load' })
      } catch (e: unknown) {
        log.warn('voice-turn', 'mount.read-settings failed', { error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
      if (tdWorker) {
        try { tdWorker.terminate() } catch { /* */ }
        tdWorker = null
      }
    }
  }, [])

  // First-run tour: auto-open if not completed, after mic wizard's chance to
  // claim attention. Skipped in E2E.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const isE2E = await window.api.app.isE2E?.()
        if (cancelled || isE2E) return
        if (hasCompletedTour()) return
        if (useVoice.getState().wizardOpen) return
        useTour.getState().start()
      } catch { /* */ }
    })()
    return () => { cancelled = true }
  }, [])

  // F7: arm the wizard on mount when the user has not completed it under the
  // current schema, unless we're under SM_E2E. The wizard never auto-opens —
  // it opens on the first mic click while armed (see VoiceButton).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const isE2E = await window.api.app.isE2E?.()
        if (cancelled) return
        if (isE2E) {
          log.info('voice-wizard', 'auto-arm.skipped-e2e')
          return
        }
        const state = await window.api.voice.getWizardState()
        if (cancelled) return
        if (state.completedSchema !== state.currentSchema) {
          useVoice.getState().setWizardArmed(true)
          log.info('voice-wizard', 'auto-arm', {
            completedSchema: state.completedSchema,
            currentSchema: state.currentSchema,
          })
        }
      } catch (e: unknown) {
        log.warn('voice-wizard', 'auto-arm failed', { error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Simple mode: chrome-free single terminal. Early-return is after all hooks
  // above (React rules), so background services still init the same way.
  if (simpleMode === true) return <SimpleShell />

  return (
    <div className={`h-full w-full flex flex-col bg-bg text-fg text-sm ${isRecording ? 'pt-7' : ''}`}>
      {/* Privacy invariant (CLAUDE.md): RecordingStatus must remain mounted
          whenever isRecording === true. It is fixed-positioned at z-[60] so
          it paints over any z-50 overlay (Modal, CommandPalette). The pt-7
          spacer on the outer container shifts the rest of the app down by
          the banner's 28px height so TabBar stays visible. */}
      <RecordingStatus />
      <SuperAgentStatusBar />
      <OrchestratorStatusPanel />
      <TabBar />
      <div className="flex-1 flex min-h-0">
        <AlmanacSidebar
          active={activeNav}
          onNavigate={navigate}
          onNewSession={handleNewSession}
        />
        <MainPane
          active={activeNav}
          onNavigate={navigate}
          onNewSession={handleNewSession}
          onOpenVoice={() => navigate('voice')}
          onOpenScheduler={() => navigate('scheduler')}
          searchMode={searchMode}
          broadcastOpen={broadcastOpen}
          watchersOpen={watchersOpen}
          onCloseBroadcast={() => setBroadcastOpen(false)}
          onCloseWatchers={() => setWatchersOpen(false)}
        />
      </div>
      <AlmanacFooter onNavigate={navigate} />

      {/* v0.13.1 — all former-modal tools render as full pages via MainPane.
       *  No App-level modal mounts remain. */}

      {/* F7 first-run mic check. Renders unconditionally (Modal returns null
          when closed). Open/close lifecycle is owned by the voice store. */}
      <MicWizard open={wizardOpen} onClose={closeWizard} />
      <TourOverlay />
      {/* Toast host — z-[55] sits above z-50 dialogs but below z-[60]
          RecordingStatus so the privacy banner is never obscured. */}
      <Toast />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onCommand={(cmd: Command) => {
          setPaletteOpen(false)
          if (cmd.id.startsWith('nav:')) {
            navigate(cmd.id.slice(4) as NavKey)
          } else if (cmd.id === 'doc:open-file' || cmd.id.startsWith('doc:recent:')) {
            navigate('doc-editor')
          }
        }}
      />
    </div>
  )
}

