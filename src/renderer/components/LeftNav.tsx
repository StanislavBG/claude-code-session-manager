import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceButton, TTSToggle } from './VoiceButton'
import { MicDevicePicker } from './MicDevicePicker'
import { MicLevelMeter } from './MicLevelMeter'
import { SchedulePanel } from './SchedulePanel'
import { SubmitCountdown } from './SubmitCountdown'
import { useVoice } from '../state/voice'
import { useLive } from '../state/live'
import { useScheduleState } from '../state/scheduleState'
import { useSessions } from '../state/sessions'
import { useWatchers } from '../state/watchers'
import { log } from '../lib/logger'
import { useDensity, type Density } from '../lib/useDensity'
import { StatusDot } from './ui/StatusDot'
import { Tooltip } from './ui/Tooltip'
import type { VoiceHotkeyConfig } from '../../preload/api'

export type NavKey =
  | 'overview'
  | 'terminal'
  | 'system-prompt'
  | 'settings'
  | 'permissions'
  | 'skills'
  | 'plugins'
  | 'mcp'
  | 'hooks'
  | 'subagents'
  | 'plans'
  | 'tasks'
  | 'memory'
  | 'projects'
  | 'history'
  | 'keybindings'
  | 'usage'
  | 'agent-view'
  | 'doc-editor'

type NavItem = { key: NavKey; label: string; liveKind?: 'subagents' | 'tasks' | 'agentView' }

const GROUPS: { title: string; storageKey: string; items: NavItem[] }[] = [
  {
    title: 'Workspace',
    storageKey: 'workspace',
    items: [
      { key: 'overview', label: 'Overview' },
      { key: 'terminal', label: 'Terminal' },
      { key: 'system-prompt', label: 'System Prompt' },
      { key: 'agent-view', label: 'Agent-View', liveKind: 'agentView' },
    ],
  },
  {
    title: 'Config',
    storageKey: 'config',
    items: [
      { key: 'settings', label: 'Settings' },
      { key: 'permissions', label: 'Permissions' },
      { key: 'skills', label: 'Skills' },
      { key: 'plugins', label: 'Plugins' },
      { key: 'mcp', label: 'MCP Servers' },
      { key: 'hooks', label: 'Hooks' },
      { key: 'subagents', label: 'Subagents', liveKind: 'subagents' },
      { key: 'keybindings', label: 'Keybindings' },
    ],
  },
  {
    title: 'Activity',
    storageKey: 'activity',
    items: [
      { key: 'plans', label: 'Plans' },
      { key: 'tasks', label: 'Tasks', liveKind: 'tasks' },
      { key: 'memory', label: 'Memory' },
      { key: 'projects', label: 'Projects' },
      { key: 'history', label: 'History' },
      { key: 'usage', label: 'Usage' },
      { key: 'doc-editor', label: 'Doc Editor' },
    ],
  },
]

const WIDTH_KEY = 'sm.leftNavWidth'
const DEFAULT_WIDTH = 240
const MIN_WIDTH = 200
const MAX_WIDTH = 420

const LIVE_TOOLTIPS: Record<'subagents' | 'tasks' | 'agentView', string> = {
  subagents: 'A subagent was spawned in the last minute',
  tasks: 'A task is currently in progress',
  agentView: 'Claude is working right now',
}

function useLiveIndicators() {
  const tabs = useLive((s) => s.tabs)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // 5s tick is sufficient for the 60s "subagent spawned" and 5s "working
    // now" windows; 1Hz would re-render every nav button each second.
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])
  const list = Object.values(tabs)
  return {
    subagents: list.some((t) => t.agents.some((a) => now - a.at < 60_000)),
    tasks: list.some((t) => t.todos.some((todo) => todo.status === 'in_progress')),
    agentView: list.some((t) => t.lastEventAt > 0 && now - t.lastEventAt < 5_000),
  }
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    if (!raw) return DEFAULT_WIDTH
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return DEFAULT_WIDTH
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n))
  } catch {
    return DEFAULT_WIDTH
  }
}

function saveWidth(w: number) {
  try { localStorage.setItem(WIDTH_KEY, String(w)) } catch { /* */ }
}

/** Window-level mouse listeners (not handle-local) so the drag survives
 *  the cursor leaving the handle's hit area. */
function ResizeHandle({ onResize }: { onResize: (deltaX: number) => void }) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const dx = ev.clientX - startX.current
      startX.current = ev.clientX
      onResize(dx)
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [onResize])

  return (
    <div
      onMouseDown={onMouseDown}
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors z-10"
      title="Drag to resize"
    />
  )
}

function loadCollapsed(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(`sm.leftNav.section.${key}.collapsed`)
    if (raw === null) return fallback
    return raw === '1'
  } catch {
    return fallback
  }
}

function saveCollapsed(key: string, collapsed: boolean) {
  try { localStorage.setItem(`sm.leftNav.section.${key}.collapsed`, collapsed ? '1' : '0') } catch { /* */ }
}

function CollapsibleSection({
  title, storageKey, defaultCollapsed = false, badge, children,
}: {
  title: string
  storageKey: string
  defaultCollapsed?: boolean
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(storageKey, defaultCollapsed))
  const toggle = () => {
    const v = !collapsed
    setCollapsed(v)
    saveCollapsed(storageKey, v)
  }
  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={toggle}
        className="w-full px-3 py-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-fg-faint hover:text-fg-dim"
      >
        <span className="flex items-center gap-2">
          <span>{title}</span>
          {badge}
        </span>
        <span>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && children}
    </div>
  )
}

interface LeftNavProps {
  active: NavKey
  onChange: (k: NavKey) => void
  onNewSession?: () => void
  onRestartSession?: () => void
  onRestartApp?: () => void
  onToggleBroadcast?: () => void
  onToggleWatchers?: () => void
  broadcastOpen?: boolean
  watchersOpen?: boolean
}

export function LeftNav({
  active,
  onChange,
  onNewSession,
  onRestartSession,
  onRestartApp,
  onToggleBroadcast,
  onToggleWatchers,
  broadcastOpen = false,
  watchersOpen = false,
}: LeftNavProps) {
  const indicators = useLiveIndicators()
  const [width, setWidth] = useState<number>(() => loadWidth())

  const onResize = useCallback((dx: number) => {
    setWidth((prev) => {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, prev + dx))
      saveWidth(next)
      return next
    })
  }, [])

  return (
    <nav
      className="bg-bg-elev border-r border-line shrink-0 overflow-hidden flex flex-col relative"
      style={{ width: `${width}px` }}
    >
      <div className="flex-1 min-h-0 overflow-y-auto">
        {GROUPS.map((group) => {
          // Bubble live activity up to the group header so collapsing a group
          // doesn't hide a working/active indicator.
          const groupLive = group.items.some((it) => it.liveKind && indicators[it.liveKind])
          const groupBadge = groupLive
            ? <StatusDot state="attention" pulse title="live activity in this group" />
            : null
          return (
            <CollapsibleSection
              key={group.storageKey}
              title={group.title}
              storageKey={group.storageKey}
              badge={groupBadge}
            >
              {group.items.map((item) => {
                const liveActive = item.liveKind ? indicators[item.liveKind] : false
                const tooltip = item.liveKind && liveActive ? LIVE_TOOLTIPS[item.liveKind] : undefined
                return (
                  <button
                    key={item.key}
                    onClick={() => onChange(item.key)}
                    title={tooltip}
                    className={`w-full text-left px-4 py-1.5 compact:py-1 text-xs flex items-center justify-between transition-colors ${
                      active === item.key
                        ? 'bg-bg-hi text-fg border-l-2 border-accent'
                        : 'text-fg-dim hover:text-fg hover:bg-bg-hi border-l-2 border-transparent'
                    }`}
                  >
                    <span>{item.label}</span>
                    {liveActive && <StatusDot state="attention" pulse />}
                  </button>
                )
              })}
            </CollapsibleSection>
          )
        })}
      </div>

      {onNewSession && (
        <div className="shrink-0 max-h-[60vh] overflow-y-auto">
          <SchedulerSection />
          <MicrophoneSection />
          <SessionSection
            onNewSession={onNewSession}
            onRestartSession={onRestartSession}
            onRestartApp={onRestartApp}
            onToggleBroadcast={onToggleBroadcast}
            onToggleWatchers={onToggleWatchers}
            broadcastOpen={broadcastOpen}
            watchersOpen={watchersOpen}
          />
          <DensityToggle />
        </div>
      )}

      <ResizeHandle onResize={onResize} />
    </nav>
  )
}

/** Scheduler section — auto-expanded when work is queued or in flight, so the
 *  user always sees pending work. The badge shows pending count. */
function SchedulerSection() {
  const [pendingCount, setPendingCount] = useState(0)
  const [activeBadge, setActiveBadge] = useState<'idle' | 'running' | 'paused'>('idle')

  // Snapshot lives in state/scheduleState.ts; the singleton poller updates it.
  const snap = useScheduleState((s) => s.snapshot)
  useEffect(() => {
    if (!snap) return
    const p = snap.jobs.filter((j) => j.status === 'pending').length
    const r = snap.jobs.some((j) => j.status === 'running')
    const next: 'idle' | 'running' | 'paused' = snap.paused ? 'paused' : (r ? 'running' : 'idle')
    setPendingCount((prev) => (prev === p ? prev : p))
    setActiveBadge((prev) => (prev === next ? prev : next))
  }, [snap])

  const hasWork = pendingCount > 0 || activeBadge !== 'idle'
  const badge = (
    <span className="flex items-center gap-1">
      {pendingCount > 0 && (
        <span className="px-1.5 py-0.5 rounded bg-bg text-fg-dim font-mono normal-case tracking-normal">
          {pendingCount}
        </span>
      )}
      {activeBadge === 'running' && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/15 text-accent normal-case tracking-normal"
          title="a scheduler job is running"
        >
          <StatusDot state="attention" pulse />
          <span className="text-[9px] font-medium">working</span>
        </span>
      )}
      {activeBadge === 'paused' && <span className="text-amber-400" title="paused">⏸</span>}
    </span>
  )

  return (
    <CollapsibleSection
      title="Scheduler"
      storageKey="scheduler"
      defaultCollapsed={!hasWork}
      badge={badge}
    >
      <SchedulePanel />
    </CollapsibleSection>
  )
}

function MicrophoneSection() {
  const isRecording = useVoice((s) => s.isRecording)
  const error = useVoice((s) => s.error)
  const badge = (
    <span className="flex items-center gap-1">
      {isRecording && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" title="recording" />}
      {error && <span className="text-red-400" title={error}>⚠</span>}
    </span>
  )

  return (
    <CollapsibleSection
      title="Microphone"
      storageKey="microphone"
      defaultCollapsed={false}
      badge={badge}
    >
      <MicActivityPanel />
      <SubmitCountdown />
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
        <VoiceButton />
        <MicDevicePicker />
        <TTSToggle />
      </div>
      <HotkeyHint />
      <div className="px-3 pb-2 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => useVoice.getState().openWizard()}
          className="text-[10px] text-fg-faint hover:text-fg-dim underline"
          data-testid="run-mic-check"
        >
          Run mic check
        </button>
        <HotkeyModeToggle />
      </div>
      <MicLevelMeter />
    </CollapsibleSection>
  )
}

/** Shows the configured hotkey accelerator when the mic is idle so the user
 *  always knows how to start recording. Hidden while recording (the level
 *  meter + countdown bar carry the active state). */
function HotkeyHint() {
  const isRecording = useVoice((s) => s.isRecording)
  const [cfg, setCfg] = useState<VoiceHotkeyConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.voice.getHotkeyConfig()
      .then((c) => { if (!cancelled) setCfg(c) })
      .catch(() => {})
    const off = window.api.voice.onHotkeyConfigChanged((c) => setCfg(c))
    return () => { cancelled = true; off() }
  }, [])

  if (isRecording || !cfg) return null
  const verb = cfg.mode === 'hold' ? 'Hold' : 'Press'
  const label = formatAccelerator(cfg.accelerator)
  return (
    <div className="px-3 pb-1 text-[10px] text-fg-faint">
      <span>{verb} </span>
      <kbd className="px-1 py-0.5 rounded border border-line bg-bg font-mono text-fg-dim">{label}</kbd>
      <span> to record</span>
    </div>
  )
}

function formatAccelerator(accel: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
  return accel
    .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/CmdOrCtrl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Option/g, isMac ? '⌥' : 'Alt')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
}

function SessionSection({
  onNewSession,
  onRestartSession,
  onRestartApp,
  onToggleBroadcast,
  onToggleWatchers,
  broadcastOpen,
  watchersOpen,
}: {
  onNewSession: () => void
  onRestartSession?: () => void
  onRestartApp?: () => void
  onToggleBroadcast?: () => void
  onToggleWatchers?: () => void
  broadcastOpen: boolean
  watchersOpen: boolean
}) {
  const activeTabId = useSessions((s) => s.activeTabId)
  const tabs = useSessions((s) => s.tabs)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const sessionRestartable = activeTab?.status === 'running'
  const watcherCount = useWatchers((s) =>
    activeTab ? s.watchersForTab(activeTab.id).length : 0,
  )

  return (
    <CollapsibleSection
      title="Session"
      storageKey="session"
      defaultCollapsed={false}
    >
      <div className="px-3 py-2 space-y-1.5">
        <button
          onClick={onNewSession}
          className="w-full px-3 py-1.5 text-xs text-fg-dim hover:text-fg bg-bg hover:bg-bg-hi border border-line rounded transition-colors"
        >
          + New Session
        </button>
        <div className="grid grid-cols-2 gap-1.5">
          <Tooltip content="Kill claude and start a fresh session in the same directory (picks up config changes).">
            <button
              type="button"
              onClick={onRestartSession}
              disabled={!sessionRestartable || !onRestartSession}
              className="w-full px-2 py-1 text-[11px] text-fg-dim hover:text-fg border border-line rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-fg-dim"
              title="Restart current session"
            >
              Restart Session
            </button>
          </Tooltip>
          <Tooltip content="Kill all sessions, quit the app, and relaunch — all tabs restore automatically.">
            <button
              type="button"
              onClick={onRestartApp}
              disabled={!onRestartApp}
              className="w-full px-2 py-1 text-[11px] text-fg-dim hover:text-fg border border-line rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Restart Session Manager (Ctrl+Shift+R)"
            >
              Restart App
            </button>
          </Tooltip>
          <Tooltip content="Send the same prompt to multiple selected tabs at once.">
            <button
              type="button"
              onClick={onToggleBroadcast}
              disabled={!onToggleBroadcast}
              aria-pressed={broadcastOpen}
              data-testid="broadcast-toggle"
              className={`w-full px-2 py-1 text-[11px] border rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                broadcastOpen
                  ? 'bg-bg-hi text-fg border-fg-faint'
                  : 'text-fg-dim hover:text-fg border-line'
              }`}
            >
              Broadcast
            </button>
          </Tooltip>
          <Tooltip content="Attach a long-running shell command (e.g. npm test --watch, tail -f) to the current tab.">
            <button
              type="button"
              onClick={onToggleWatchers}
              disabled={!activeTab || !onToggleWatchers}
              aria-pressed={watchersOpen}
              data-testid="watchers-toggle"
              className={`w-full px-2 py-1 text-[11px] border rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                watchersOpen
                  ? 'bg-bg-hi text-fg border-fg-faint'
                  : 'text-fg-dim hover:text-fg border-line'
              }`}
            >
              Watchers{watcherCount > 0 ? ` (${watcherCount})` : ''}
            </button>
          </Tooltip>
        </div>
      </div>
    </CollapsibleSection>
  )
}

function HotkeyModeToggle() {
  const [cfg, setCfg] = useState<VoiceHotkeyConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.voice.getHotkeyConfig()
      .then((c) => { if (!cancelled) setCfg(c) })
      .catch((e) => log.warn('voice-hotkey', 'getHotkeyConfig (toggle) failed', { error: String(e) }))
    const off = window.api.voice.onHotkeyConfigChanged((c) => { setCfg(c) })
    return () => { cancelled = true; off() }
  }, [])

  if (!cfg) return null

  const onChange = async (mode: 'hold' | 'toggle') => {
    if (cfg.mode === mode) return
    const next: VoiceHotkeyConfig = { ...cfg, mode }
    setCfg(next)
    try {
      await window.api.voice.setHotkeyConfig(next)
    } catch (e: unknown) {
      log.warn('voice-hotkey', 'setHotkeyConfig (toggle) failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div
      className="flex items-center gap-2 text-[10px] text-fg-faint select-none"
      title="Mic hotkey behavior. Tap on/off: press once to start, again to stop. Hold to talk: record only while held (push-to-talk)."
    >
      <label className="flex items-center gap-0.5 cursor-pointer hover:text-fg-dim">
        <input
          type="radio"
          name="hotkey-mode"
          checked={cfg.mode === 'toggle'}
          onChange={() => onChange('toggle')}
          className="cursor-pointer"
          data-testid="hotkey-mode-toggle"
        />
        <span>Tap on/off</span>
      </label>
      <label className="flex items-center gap-0.5 cursor-pointer hover:text-fg-dim">
        <input
          type="radio"
          name="hotkey-mode"
          checked={cfg.mode === 'hold'}
          onChange={() => onChange('hold')}
          className="cursor-pointer"
          data-testid="hotkey-mode-hold"
        />
        <span>Hold to talk</span>
      </label>
    </div>
  )
}


/** Voice activity panel for the LeftNav — distinct from the App-level
 *  privacy banner in components/RecordingStatus.tsx. Shows model loading
 *  progress, last transcript, or errors, depending on voice store state. */
function MicActivityPanel() {
  const isRecording = useVoice((s) => s.isRecording)
  const lastTranscript = useVoice((s) => s.lastTranscript)
  const error = useVoice((s) => s.error)
  const modelStatus = useVoice((s) => s.modelStatus)
  const loadingProgress = useVoice((s) => s.loadingProgress)

  if (error) {
    return (
      <div className="px-3 py-2 text-[11px] text-red-400 truncate" title={error}>
        ⚠ {error}
      </div>
    )
  }
  if (!isRecording) {
    if (modelStatus === 'loading') {
      return (
        <div className="px-3 py-2 text-[11px] text-fg-faint">
          <div className="flex items-center justify-between mb-1">
            <span>Loading speech model</span>
            <span className="font-mono">{loadingProgress}%</span>
          </div>
          <div className="h-1 rounded bg-bg overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${loadingProgress}%` }}
            />
          </div>
        </div>
      )
    }
    return null
  }
  return (
    <div className="px-3 py-2 flex items-center gap-2 text-[11px] text-fg-dim border-b border-line">
      <span className="inline-block w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
      <span className="truncate" title={lastTranscript}>
        {lastTranscript || 'Listening…'}
      </span>
    </div>
  )
}

/** Density toggle — compact|roomy segmented control. Persists to localStorage
 *  via useDensity(); changing it toggles `body.density-compact` so any
 *  `compact:` Tailwind variant applies app-wide. */
function DensityToggle() {
  const { density, setDensity } = useDensity()
  const opt = (d: Density, label: string) => (
    <button
      key={d}
      type="button"
      onClick={() => setDensity(d)}
      aria-pressed={density === d}
      className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
        density === d
          ? 'bg-bg text-fg border border-line'
          : 'text-fg-faint hover:text-fg-dim border border-transparent'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div className="border-t border-line px-3 py-1.5 flex items-center justify-between text-[10px] text-fg-faint">
      <span className="uppercase tracking-wider">Density</span>
      <span className="flex items-center gap-1" role="group" aria-label="UI density">
        {opt('compact', 'compact')}
        {opt('roomy', 'roomy')}
      </span>
    </div>
  )
}
