import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TabBar } from './components/TabBar'
import { type NavKey } from './components/LeftNav'
import { Header, type ScreenKey } from './components/layout/Header'
import { TabModal } from './components/layout/TabModal'
import { VoiceModal } from './components/layout/VoiceModal'
import { SchedulerModal } from './components/layout/SchedulerModal'
import { StatusBar } from './components/StatusBar'
import { MainPane } from './components/MainPane'
import { RecordingStatus } from './components/RecordingStatus'
import { MicWizard } from './components/MicWizard'
import { CommandPalette, type Command } from './components/CommandPalette'
import { Toast } from './components/ui/Toast'
import { Settings } from './components/tabs/Settings'
import { SystemPrompt } from './components/tabs/SystemPrompt'
import { Keybindings } from './components/tabs/Keybindings'
import { Permissions } from './components/tabs/Permissions'
import { Plugins } from './components/tabs/Plugins'
import { McpServers } from './components/tabs/McpServers'
import { Hooks } from './components/tabs/Hooks'
import { Plans } from './components/tabs/Plans'
import { Tasks } from './components/tabs/Tasks'
import { Memory } from './components/tabs/Memory'
import { Projects } from './components/tabs/Projects'
import { DocEditor } from './components/tabs/DocEditor'
import { toast } from './state/toast'
import { installConfigChangeListener } from './state/config'
import { installMonacoSchemas } from './components/ui/JsonEditor'
import { useSessions, hydrateSessions } from './state/sessions'
import { useWatchers } from './state/watchers'
import { startBillingPolling } from './state/billing'
import { startTeamsPolling } from './state/teams'
import { startSchedulePolling } from './state/scheduleState'
import { DEFAULT_PRESETS, renderCommand, resolvePresetCwd } from './lib/presets'
import { createPickedSession } from './lib/createPickedSession'
import { useVoiceTTS } from './lib/useVoiceTTS'
import { useVoice, type HotkeyMode } from './state/voice'
import { isRecognitionSupported } from './lib/speechRecognition'
import { log } from './lib/logger'

// Module-scope once-flag for the unsupported warning. Survives StrictMode
// double-effect; resets only on full reload.
let unsupportedLogged = false

/** Which NavKeys are rendered as full screens via Header tabs. Everything
 *  else is treated as a modal target. Keeping the wider NavKey union lets
 *  existing callers (CommandPalette nav:*, Overview's InstrumentTile linkTo,
 *  LearningPanel) keep working — App.tsx routes screen keys to setActiveNav
 *  and any other NavKey to setOpenModal. */
const SCREEN_KEYS = new Set<NavKey>([
  'overview',
  'terminal',
  'agent-view',
  'skills',
  'history',
  'usage',
  'subagents',
])

export function App() {
  const [activeNav, setActiveNav] = useState<NavKey>('terminal')
  const [openModal, setOpenModal] = useState<NavKey | 'voice' | 'scheduler' | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [watchersOpen, setWatchersOpen] = useState(false)

  // Route any NavKey to the right destination. Used by CommandPalette nav:*
  // entries, Overview's tile links, and Header's More menu.
  const navigate = useCallback((k: NavKey) => {
    if (SCREEN_KEYS.has(k)) {
      setActiveNav(k)
      setOpenModal(null)
    } else {
      setOpenModal(k)
    }
  }, [])

  const closeModal = useCallback(() => setOpenModal(null), [])
  const activeTabId = useSessions((s) => s.activeTabId)
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
    // First, hydrate persisted tabs from disk. If any tabs come back, their
    // startupCommand is `claude --resume <id>` so the transcript + plan
    // history is reattached automatically. If nothing was persisted, fall
    // through to the fresh auto-spawn path.
    hydrateSessions().then(() => {
      if (useSessions.getState().tabs.length > 0) return
      const preset = DEFAULT_PRESETS[0]
      resolvePresetCwd(preset)
        .then((cwd) => {
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
        })
        .catch((e) => {
          console.warn('[App] failed to create initial tab:', e)
          toast.error('Failed to create initial tab. Is the claude CLI on PATH?')
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
      off(); offNewSession(); offReboot(); offCfg(); offHotkey()
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

  return (
    <div className={`h-full w-full flex flex-col bg-bg text-fg text-sm ${isRecording ? 'pt-7' : ''}`}>
      {/* Privacy invariant (CLAUDE.md): RecordingStatus must remain mounted
          whenever isRecording === true. It is fixed-positioned at z-[60] so
          it paints over any z-50 overlay (Modal, CommandPalette). The pt-7
          spacer on the outer container shifts the rest of the app down by
          the banner's 28px height so TabBar stays visible. */}
      <RecordingStatus />
      <TabBar />
      <Header
        active={activeNav}
        onScreenChange={(k: ScreenKey) => { setActiveNav(k); setOpenModal(null) }}
        onOpenModal={navigate}
        onNewSession={handleNewSession}
        onRestartSession={restartActiveTab}
        onRestartApp={rebootApp}
        onToggleBroadcast={toggleBroadcast}
        onToggleWatchers={toggleWatchers}
        onOpenVoice={() => setOpenModal('voice')}
        onOpenScheduler={() => setOpenModal('scheduler')}
        broadcastOpen={broadcastOpen}
        watchersOpen={watchersOpen}
      />
      <div className="flex-1 flex min-h-0">
        <MainPane
          active={activeNav}
          onNavigate={navigate}
          broadcastOpen={broadcastOpen}
          watchersOpen={watchersOpen}
          onCloseBroadcast={() => setBroadcastOpen(false)}
          onCloseWatchers={() => setWatchersOpen(false)}
        />
      </div>
      <StatusBar />

      {/* Tab-as-modal overlays. NavKey targets are routed through navigate(),
       *  which sets openModal to the relevant key. Each modal mounts only when
       *  its key matches so we don't pay for hidden subscriptions. */}
      <ModalRouter openModal={openModal} onClose={closeModal} />
      <VoiceModal open={openModal === 'voice'} onClose={closeModal} />
      <SchedulerModal open={openModal === 'scheduler'} onClose={closeModal} />

      {/* F7 first-run mic check. Renders unconditionally (Modal returns null
          when closed). Open/close lifecycle is owned by the voice store. */}
      <MicWizard open={wizardOpen} onClose={closeWizard} />
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

/** Dispatch for the 12 NavKeys that are rendered as modal overlays.
 *  Voice/Scheduler aren't NavKeys so they have their own dedicated modals
 *  in App.tsx; everything here is a former-tab whose component we
 *  wrap in TabModal unchanged. */
function ModalRouter({
  openModal,
  onClose,
}: {
  openModal: NavKey | 'voice' | 'scheduler' | null
  onClose: () => void
}) {
  const titleMap = useMemo<Partial<Record<NavKey, string>>>(() => ({
    'settings': 'Settings',
    'permissions': 'Permissions',
    'system-prompt': 'System Prompt / Personality',
    'keybindings': 'Keybindings',
    'memory': 'Memory',
    'plugins': 'Plugins',
    'mcp': 'MCP Servers',
    'hooks': 'Hooks',
    'plans': 'Plans',
    'tasks': 'Tasks / Todos',
    'projects': 'Projects',
    'doc-editor': 'Doc Editor',
  }), [])

  const render = (): React.ReactNode => {
    switch (openModal) {
      case 'settings': return <Settings />
      case 'permissions': return <Permissions />
      case 'system-prompt': return <SystemPrompt />
      case 'keybindings': return <Keybindings />
      case 'memory': return <Memory />
      case 'plugins': return <Plugins />
      case 'mcp': return <McpServers />
      case 'hooks': return <Hooks />
      case 'plans': return <Plans />
      case 'tasks': return <Tasks />
      case 'projects': return <Projects />
      case 'doc-editor': return <DocEditor />
      default: return null
    }
  }

  const title = openModal && openModal !== 'voice' && openModal !== 'scheduler'
    ? titleMap[openModal] ?? ''
    : ''

  const isTabModal = openModal !== null && openModal !== 'voice' && openModal !== 'scheduler' && title !== ''

  return (
    <TabModal open={isTabModal} onClose={onClose} title={title}>
      {render()}
    </TabModal>
  )
}
