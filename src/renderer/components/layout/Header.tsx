import { useEffect, useRef, useState } from 'react'
import type { NavKey } from '../LeftNav'
import { useSessions } from '../../state/sessions'
import { useLive } from '../../state/live'
import { useVoice } from '../../state/voice'
import { useScheduleState } from '../../state/scheduleState'
import { useWatchers } from '../../state/watchers'
import { StatusDot } from '../ui/StatusDot'
import { Tooltip } from '../ui/Tooltip'
import { NotificationCenter } from './NotificationCenter'
import { GitActionsMenu } from './GitActionsMenu'
import { DeployMenu } from './DeployMenu'

/**
 * Top navigation header — mirror of ClaudeCodeUnleashed's Header pattern.
 * Replaces the old LeftNav. Three regions:
 *   1. Folder / cwd display on the left
 *   2. Primary screen tabs in the middle (7 destinations rendered in MainPane)
 *   3. Right cluster of icon buttons for modal-style features + "More" overflow
 *
 * Modal destinations still use NavKey values so existing callers
 * (CommandPalette nav:*, Overview's InstrumentTile linkTo, Learning content)
 * stay correct without rewiring — App.tsx routes screen keys to setActiveNav
 * and modal keys to setOpenModal.
 */

export type ScreenKey = 'overview' | 'terminal' | 'agent-view' | 'skills' | 'history' | 'usage' | 'subagents'

export const SCREENS: { key: ScreenKey; label: string; liveKind?: 'subagents' | 'tasks' | 'agentView' }[] = [
  { key: 'overview', label: 'Home' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'agent-view', label: 'Agent-View', liveKind: 'agentView' },
  { key: 'skills', label: 'Skills' },
  { key: 'history', label: 'History' },
  { key: 'usage', label: 'Usage' },
  { key: 'subagents', label: 'Hive', liveKind: 'subagents' },
]

const ICON_BUTTONS: { key: NavKey; label: string; glyph: string }[] = [
  { key: 'settings', label: 'Settings', glyph: '⚙' },
  { key: 'memory', label: 'Memory', glyph: '◈' },
  { key: 'permissions', label: 'Permissions', glyph: '🔒' },
  { key: 'system-prompt', label: 'System Prompt', glyph: '✎' },
]

const MORE_GROUPS: { title: string; items: { key: NavKey; label: string }[] }[] = [
  {
    title: 'Config',
    items: [
      { key: 'plugins', label: 'Plugins' },
      { key: 'mcp', label: 'MCP Servers' },
      { key: 'hooks', label: 'Hooks' },
      { key: 'keybindings', label: 'Keybindings' },
    ],
  },
  {
    title: 'Activity',
    items: [
      { key: 'plans', label: 'Plans' },
      { key: 'tasks', label: 'Tasks' },
      { key: 'projects', label: 'Projects' },
      { key: 'doc-editor', label: 'Doc Editor' },
    ],
  },
]

function useLiveIndicators() {
  const tabs = useLive((s) => s.tabs)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
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

interface HeaderProps {
  active: NavKey
  onScreenChange: (k: ScreenKey) => void
  onOpenModal: (k: NavKey) => void
  onNewSession: () => void
  onRestartSession: () => void
  onRestartApp: () => void
  onToggleBroadcast: () => void
  onToggleWatchers: () => void
  onOpenVoice: () => void
  onOpenScheduler: () => void
  broadcastOpen: boolean
  watchersOpen: boolean
}

export function Header({
  active,
  onScreenChange,
  onOpenModal,
  onNewSession,
  onRestartSession,
  onRestartApp,
  onToggleBroadcast,
  onToggleWatchers,
  onOpenVoice,
  onOpenScheduler,
  broadcastOpen,
  watchersOpen,
}: HeaderProps) {
  const indicators = useLiveIndicators()
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const sessionRestartable = activeTab?.status === 'running'

  return (
    <header className="shrink-0 bg-bg-elev border-b border-line flex items-stretch h-10">
      <FolderPill cwd={activeTab?.cwd ?? null} />

      <nav className="flex items-stretch" role="tablist" aria-label="Primary navigation">
        {SCREENS.map((s) => {
          const liveActive = s.liveKind ? indicators[s.liveKind] : false
          const isActive = active === s.key
          return (
            <button
              key={s.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => onScreenChange(s.key)}
              className={`px-3 text-xs flex items-center gap-1.5 border-b-2 transition-colors ${
                isActive
                  ? 'text-fg border-accent bg-bg-hi/40'
                  : 'text-fg-dim hover:text-fg border-transparent hover:bg-bg-hi/30'
              }`}
            >
              <span>{s.label}</span>
              {liveActive && <StatusDot state="attention" pulse />}
            </button>
          )
        })}
      </nav>

      <div className="flex-1" />

      <div className="flex items-stretch gap-0.5 pr-1">
        <SessionCluster
          onNewSession={onNewSession}
          onRestartSession={onRestartSession}
          onRestartApp={onRestartApp}
          onToggleBroadcast={onToggleBroadcast}
          onToggleWatchers={onToggleWatchers}
          broadcastOpen={broadcastOpen}
          watchersOpen={watchersOpen}
          sessionRestartable={sessionRestartable}
        />

        <Divider />

        <SchedulerButton onOpen={onOpenScheduler} />
        <VoiceButton onOpen={onOpenVoice} />
        <NotificationCenter />

        <Divider />

        <GitActionsMenu />
        <DeployMenu />

        <Divider />

        {ICON_BUTTONS.map((b) => (
          <Tooltip key={b.key} content={b.label}>
            <IconButton
              label={b.label}
              glyph={b.glyph}
              onClick={() => onOpenModal(b.key)}
            />
          </Tooltip>
        ))}

        <MoreMenu onSelect={onOpenModal} />
      </div>
    </header>
  )
}

function FolderPill({ cwd }: { cwd: string | null }) {
  const name = cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : 'no folder'
  return (
    <div
      className="flex items-center px-3 border-r border-line text-xs font-mono text-fg-dim min-w-0 max-w-[280px]"
      title={cwd ?? ''}
    >
      <span className="mr-1.5 text-fg-faint">📁</span>
      <span className="truncate">{name}</span>
    </div>
  )
}

function Divider() {
  return <span className="self-center w-px h-5 bg-line mx-1" />
}

function IconButton({
  label,
  glyph,
  onClick,
  active = false,
  disabled = false,
  badge,
}: {
  label: string
  glyph: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  badge?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`relative px-2 self-center h-7 rounded text-sm flex items-center justify-center transition-colors ${
        active
          ? 'bg-bg-hi text-fg'
          : 'text-fg-dim hover:text-fg hover:bg-bg-hi/60 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-dim'
      }`}
    >
      <span>{glyph}</span>
      {badge && (
        <span className="absolute -top-0.5 -right-0.5 leading-none">
          {badge}
        </span>
      )}
    </button>
  )
}

function SessionCluster({
  onNewSession,
  onRestartSession,
  onRestartApp,
  onToggleBroadcast,
  onToggleWatchers,
  broadcastOpen,
  watchersOpen,
  sessionRestartable,
}: {
  onNewSession: () => void
  onRestartSession: () => void
  onRestartApp: () => void
  onToggleBroadcast: () => void
  onToggleWatchers: () => void
  broadcastOpen: boolean
  watchersOpen: boolean
  sessionRestartable: boolean
}) {
  const activeTab = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
  const watcherCount = useWatchers((s) =>
    activeTab ? s.watchersForTab(activeTab.id).length : 0,
  )

  return (
    <>
      <Tooltip content="New Session (pick a directory)">
        <IconButton label="New session" glyph="+" onClick={onNewSession} />
      </Tooltip>
      <Tooltip content="Restart current session — kills claude and respawns in same cwd">
        <IconButton
          label="Restart session"
          glyph="↻"
          onClick={onRestartSession}
          disabled={!sessionRestartable}
        />
      </Tooltip>
      <Tooltip content="Restart Session Manager — quits and relaunches the whole app (Ctrl+Shift+R)">
        <IconButton label="Restart app" glyph="⟳" onClick={onRestartApp} />
      </Tooltip>
      <Tooltip content="Broadcast — send the same prompt to multiple tabs">
        <IconButton
          label="Broadcast"
          glyph="📣"
          onClick={onToggleBroadcast}
          active={broadcastOpen}
        />
      </Tooltip>
      <Tooltip content={`Watchers — attach long-running shell commands to this tab${watcherCount > 0 ? ` (${watcherCount} active)` : ''}`}>
        <IconButton
          label="Watchers"
          glyph="👁"
          onClick={onToggleWatchers}
          active={watchersOpen}
          disabled={!activeTab}
          badge={
            watcherCount > 0 ? (
              <span className="px-1 rounded bg-accent/30 text-accent text-[8px] font-mono">{watcherCount}</span>
            ) : null
          }
        />
      </Tooltip>
    </>
  )
}

function SchedulerButton({ onOpen }: { onOpen: () => void }) {
  const snap = useScheduleState((s) => s.snapshot)
  const pending = snap ? snap.jobs.filter((j) => j.status === 'pending').length : 0
  const running = snap ? snap.jobs.some((j) => j.status === 'running') : false
  const paused = snap?.paused ?? false

  const badge = running
    ? <StatusDot state="attention" pulse />
    : paused
      ? <span className="text-amber-400 text-[10px]">⏸</span>
      : pending > 0
        ? <span className="px-1 rounded bg-bg text-fg-dim text-[8px] font-mono">{pending}</span>
        : null

  return (
    <Tooltip content={running ? 'Scheduler — a job is running now' : paused ? 'Scheduler — paused on rate-limit' : pending > 0 ? `Scheduler — ${pending} job(s) queued` : 'Scheduler — PRD queue'}>
      <IconButton label="Scheduler" glyph="⏰" onClick={onOpen} badge={badge} />
    </Tooltip>
  )
}

function VoiceButton({ onOpen }: { onOpen: () => void }) {
  const isRecording = useVoice((s) => s.isRecording)
  const error = useVoice((s) => s.error)
  const badge = isRecording
    ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
    : error
      ? <span className="text-red-400 text-[10px]">⚠</span>
      : null
  return (
    <Tooltip content={isRecording ? 'Microphone — recording now' : error ? `Microphone error: ${error}` : 'Microphone & voice'}>
      <IconButton label="Voice" glyph="🎙" onClick={onOpen} badge={badge} />
    </Tooltip>
  )
}

function MoreMenu({ onSelect }: { onSelect: (k: NavKey) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <Tooltip content="More features (Plans, Tasks, Doc Editor, …)">
        <IconButton label="More" glyph="⋯" onClick={() => setOpen((v) => !v)} active={open} />
      </Tooltip>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-50 w-56 bg-bg-elev border border-line rounded shadow-lg py-1.5">
          {MORE_GROUPS.map((g) => (
            <div key={g.title}>
              <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-fg-faint">{g.title}</div>
              {g.items.map((it) => (
                <button
                  key={it.key}
                  onClick={() => {
                    setOpen(false)
                    onSelect(it.key)
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-fg-dim hover:bg-bg-hi hover:text-fg"
                >
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
