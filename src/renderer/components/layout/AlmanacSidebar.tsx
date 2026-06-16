/**
 * AlmanacSidebar — primary navigation. Replaces both the old top Header
 * (action toolbar) and the old LeftNav. Three nav groups (Workspace,
 * Configure, Tools), project caption, persistent recording status in the
 * footer, and a New Session primary button.
 *
 * Click handlers come in via props. Workspace + Configure items navigate via
 * `onNavigate(NavKey)` (these render as full pages in MainPane). Tools items
 * open existing modals via dedicated callbacks the same way the old Header
 * wired them, so no modal logic needs to change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NavKey } from '../LeftNav'
import { useSessions } from '../../state/sessions'
import { useLive } from '../../state/live'
import { useVoice } from '../../state/voice'
import { useScheduleState } from '../../state/scheduleState'
import { useBilling } from '../../state/billing'
import { findPreset } from '../../lib/presets'
import { AlmanacIcon, type AlmanacIconName } from './AlmanacIcon'
import { VoiceButton } from '../VoiceButton'

// v0.13.1 — Tools are now full pages too. We still keep them in a separate
// group below Configure so users see them as workflow surfaces (not
// configuration). Same NavKey type as Workspace/Configure rows.
type ToolKey = Extract<NavKey,
  | 'voice' | 'repoviz' | 'search'
>
void useBilling; void useMemo // (kept for future signal additions)


interface NavGroupItem {
  key: NavKey
  label: string
  icon: AlmanacIconName
  liveKind?: 'subagents' | 'tasks' | 'scheduler'
  hint?: string
}

const WORKSPACE: NavGroupItem[] = [
  { key: 'overview',   label: 'Home',       icon: 'home',         hint: "Today's sessions + the 5-hour window" },
  { key: 'terminal',   label: 'Terminal',   icon: 'terminal',     hint: 'Live Claude Code, in-app' },
  { key: 'subagents',  label: 'Subagents',  icon: 'hive',         liveKind: 'subagents', hint: 'Fan out work: Hive · Orchestrate · Race · Boss' },
  { key: 'scheduler',  label: 'Scheduler',  icon: 'scheduler',    liveKind: 'scheduler', hint: 'Author PRDs + run them as claude -p jobs' },
  { key: 'prompts',   label: 'Prompts',    icon: 'book',         hint: 'Click-to-insert prompt library' },
  { key: 'tasks',      label: 'Tasks',      icon: 'tasks',        liveKind: 'tasks', hint: 'Active to-dos across sessions' },
  { key: 'history',    label: 'History',    icon: 'history',      hint: 'Every session, ever — resumable' },
  { key: 'usage',      label: 'Usage',      icon: 'usage',        hint: 'Tokens, cost, sessions per day' },
  { key: 'knowledge-graph', label: 'Knowledge Graph', icon: 'knowledge-graph', hint: 'Distilled graph + Q&A over your prompt log' },
]

const CONFIGURE: NavGroupItem[] = [
  { key: 'skills',        label: 'Skills',         icon: 'skills',         hint: 'Reusable instructions Claude loads' },
  { key: 'plugins',       label: 'Plugins',        icon: 'plugins',        hint: 'Extensions for Claude Code' },
  { key: 'mcp',           label: 'MCP Servers',    icon: 'mcp',            hint: 'External tools and integrations' },
  { key: 'hooks',         label: 'Hooks',          icon: 'hooks',          hint: 'Run scripts on session events' },
  { key: 'keybindings',   label: 'Keybindings',    icon: 'keys',           hint: 'Shortcuts you can override' },
  { key: 'doc-editor',    label: 'Doc Editor',     icon: 'docs',           hint: 'Edit CLAUDE.md and friends' },
  { key: 'memory',        label: 'Memory',         icon: 'memory',         hint: 'Workspace memory store' },
  { key: 'projects',      label: 'Projects',       icon: 'projects',       hint: 'All known project folders' },
  { key: 'system-prompt', label: 'System Prompt',  icon: 'system-prompt',  hint: 'Personality and behavior' },
  { key: 'permissions',   label: 'Permissions',    icon: 'permissions',    hint: 'Allow / deny rules' },
  { key: 'settings',      label: 'Settings',       icon: 'settings',       hint: 'Theme, voice, billing window' },
  { key: 'remote',        label: 'Remote',         icon: 'remote',         hint: 'Web remote control — disabled by default' },
]

interface ToolItem {
  key: ToolKey
  label: string
  icon: AlmanacIconName
  hint?: string
}

const TOOLS: ToolItem[] = [
  { key: 'voice',             label: 'Voice',             icon: 'mic',           hint: 'Whisper transcription + push-to-talk' },
  { key: 'repoviz',           label: 'Repo Viz',          icon: 'repoviz',       hint: 'Language + directory map' },
  { key: 'search',            label: 'Search',            icon: 'global-search', hint: '⌘P file · ⌘⇧F content' },
]

// Resizable width — persisted per the user's drag, clamped to a sane range.
const WIDTH_KEY = 'sm.almanac.sidebarWidth'

const WIDTH_MIN = 180
const WIDTH_MAX = 480
const WIDTH_DEFAULT = 252
function loadWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(WIDTH_KEY) ?? '', 10)
    if (Number.isFinite(v)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, v))
  } catch { /* ignore */ }
  return WIDTH_DEFAULT
}

// Rail (collapsed) sidebar — fixed icon-only width, persisted across launches.
const RAIL_WIDTH = 52
const SIDEBAR_COLLAPSED_KEY = 'sm.almanac.sidebarCollapsed'

function loadCollapsedRail(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch { /* ignore */ }
  return false
}

// Collapsible nav groups. Each section header (Workspace / Configure / Tools)
// can be folded away independently; the set of collapsed group names is
// persisted as a JSON array.
const COLLAPSED_KEY = 'sm.almanac.collapsedGroups'
type GroupName = 'Workspace' | 'Configure' | 'Tools'

function loadCollapsed(): Set<GroupName> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((s): s is GroupName =>
      s === 'Workspace' || s === 'Configure' || s === 'Tools'))
  } catch {
    return new Set()
  }
}

function useLiveIndicators() {
  const tabs = useLive((s) => s.tabs)
  // Selector returns a primitive so this component only re-renders when the
  // boolean flips, not on every scheduler snapshot broadcast.
  const schedulerRunning = useScheduleState((s) =>
    (s.snapshot?.jobs ?? []).some((j) => j.status === 'running'),
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])
  const list = Object.values(tabs)
  return {
    subagents: list.some((t) => t.agents.some((a) => now - a.at < 60_000)),
    tasks: list.some((t) => t.todos.some((todo) => todo.status === 'in_progress')),
    scheduler: schedulerRunning,
  }
}

interface AlmanacSidebarProps {
  active: NavKey
  onNavigate: (k: NavKey) => void
  onNewSession: () => void
}

export function AlmanacSidebar({ active, onNavigate, onNewSession }: AlmanacSidebarProps) {
  const [collapsed, setCollapsed] = useState<Set<GroupName>>(() => loadCollapsed())
  const toggleGroup = useCallback((g: GroupName) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g); else next.add(g)
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(next))) }
      catch { /* ignore */ }
      return next
    })
  }, [])

  // Rail collapse — whole-sidebar icon-only mode, orthogonal to per-group fold.
  const [rail, setRail] = useState<boolean>(() => loadCollapsedRail())
  const toggleRail = useCallback(() => {
    setRail((prev) => {
      const next = !prev
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const indicators = useLiveIndicators()

  // Drag-to-resize. widthRef mirrors width so a new drag starts from the
  // current size; the move/up listeners live on window so the drag keeps
  // tracking even if the pointer leaves the thin handle.
  const [width, setWidth] = useState<number>(() => loadWidth())
  const widthRef = useRef(width)
  widthRef.current = width
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    let lastW = startW
    const onMove = (ev: PointerEvent) => {
      lastW = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startW + (ev.clientX - startX)))
      setWidth(lastW)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem(WIDTH_KEY, String(lastW)) } catch { /* ignore */ }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])
  const resetWidth = useCallback(() => {
    setWidth(WIDTH_DEFAULT)
    try { localStorage.setItem(WIDTH_KEY, String(WIDTH_DEFAULT)) } catch { /* ignore */ }
  }, [])

  return (
    <aside
      className="shrink-0 bg-bg-elev border-r border-line flex flex-col relative transition-[width] duration-150"
      style={{ width: rail ? RAIL_WIDTH : width }}
      data-testid="tour-leftnav"
      aria-label="Primary navigation"
    >
      <ProjectCaption tab={activeTab} onNewSession={onNewSession} rail={rail} onToggleRail={toggleRail} />

      <div className="flex-1 min-h-0 overflow-auto pb-3" style={{ paddingInline: rail ? '4px' : '8px' }}>
        <>
          {!rail && (
            <NavGroupHeader
              label="Workspace"
              collapsed={collapsed.has('Workspace')}
              count={WORKSPACE.length}
              onToggle={() => toggleGroup('Workspace')}
            />
          )}
          {(rail || !collapsed.has('Workspace')) && WORKSPACE.map((item) => (
            <NavRow
              key={item.key}
              item={item}
              active={active === item.key}
              live={item.liveKind ? indicators[item.liveKind] : false}
              onClick={() => onNavigate(item.key)}
              rail={rail}
            />
          ))}

          {!rail && (
            <NavGroupHeader
              label="Configure"
              collapsed={collapsed.has('Configure')}
              count={CONFIGURE.length}
              onToggle={() => toggleGroup('Configure')}
            />
          )}
          {(rail || !collapsed.has('Configure')) && CONFIGURE.map((item) => (
            <NavRow
              key={item.key}
              item={item}
              active={active === item.key}
              live={false}
              onClick={() => onNavigate(item.key)}
              rail={rail}
            />
          ))}

          {!rail && (
            <NavGroupHeader
              label="Tools"
              collapsed={collapsed.has('Tools')}
              count={TOOLS.length}
              onToggle={() => toggleGroup('Tools')}
            />
          )}
          {(rail || !collapsed.has('Tools')) && TOOLS.map((tool) => (
            <ToolRow
              key={tool.key}
              tool={tool}
              active={active === tool.key}
              onClick={() => onNavigate(tool.key)}
              rail={rail}
            />
          ))}
        </>
      </div>

      <SidebarFooter rail={rail} />

      {/* Drag-to-resize handle — hidden in rail mode since width is fixed. */}
      {!rail && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
          className="absolute top-0 right-0 h-full w-1.5 translate-x-1/2 z-10 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
        />
      )}
    </aside>
  )
}

function ProjectCaption({
  tab, onNewSession, rail, onToggleRail,
}: {
  tab: { cwd: string; label: string } | null
  onNewSession: () => void
  rail: boolean
  onToggleRail: () => void
}) {
  const name = tab?.label ?? 'no session'
  const branch = useBranch(tab?.cwd ?? null)

  if (rail) {
    return (
      <div className="flex flex-col items-center gap-1.5 pt-2 pb-2 border-b border-rule">
        <button
          onClick={onNewSession}
          data-testid="tour-new-session"
          title="New session"
          className="w-9 h-9 rounded-md bg-bg-hi border border-line text-fg hover:bg-bg-hi/80 hover:border-accent/40 transition-colors flex items-center justify-center"
        >
          <AlmanacIcon name="plus" size={15} stroke={1.8} />
        </button>
        <button
          onClick={onToggleRail}
          title="Expand sidebar"
          data-testid="sidebar-rail-toggle"
          className="w-9 h-9 rounded-md text-fg-faint hover:text-fg hover:bg-bg-hi/50 transition-colors flex items-center justify-center"
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(0deg)' }}>
            <AlmanacIcon name="chevron" size={15} stroke={1.8} />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="px-[18px] pt-[14px] pb-[10px] border-b border-rule">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold tracking-[0.06em] text-fg-faint uppercase">
          Project
        </div>
        <button
          onClick={onToggleRail}
          title="Collapse sidebar"
          data-testid="sidebar-rail-toggle"
          className="w-6 h-6 rounded-md text-fg-faint hover:text-fg hover:bg-bg-hi/50 transition-colors flex items-center justify-center"
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <AlmanacIcon name="chevron" size={13} stroke={1.8} />
          </span>
        </button>
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="self-center w-2 h-2 rounded-full bg-sage" />
        <span className="font-serif text-[18px] font-medium text-fg truncate" title={tab?.cwd ?? ''}>
          {name}
        </span>
      </div>
      <div className="text-[12px] text-fg-faint font-mono mt-0.5 truncate">
        {branch ? `⌥${branch}` : tab ? tab.cwd : '—'}
      </div>
      <div className="mt-3 flex items-stretch gap-1.5">
        <button
          onClick={onNewSession}
          data-testid="tour-new-session"
          className="flex-1 px-3 py-1.5 rounded-md bg-bg-hi border border-line text-fg text-[12.5px] font-medium hover:bg-bg-hi/80 hover:border-accent/40 transition-colors flex items-center justify-center gap-1.5"
        >
          <AlmanacIcon name="plus" size={13} stroke={1.8} />
          New session
        </button>
        <div className="flex items-center rounded-md bg-bg-hi border border-line">
          <VoiceButton />
        </div>
      </div>
    </div>
  )
}

const branchCache = new Map<string, { value: string | null; ts: number }>()
const BRANCH_TTL_MS = 30_000

function useBranch(cwd: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(() => (cwd ? branchCache.get(cwd)?.value ?? null : null))
  useEffect(() => {
    if (!cwd) { setBranch(null); return }
    let cancelled = false
    const load = async () => {
      const hit = branchCache.get(cwd)
      if (hit && Date.now() - hit.ts < BRANCH_TTL_MS) {
        if (!cancelled) setBranch(hit.value)
        return
      }
      try {
        const v = await window.api.app.gitBranch(cwd)
        if (cancelled) return
        branchCache.set(cwd, { value: v, ts: Date.now() })
        setBranch(v)
      } catch {
        if (cancelled) return
        branchCache.set(cwd, { value: null, ts: Date.now() })
        setBranch(null)
      }
    }
    load()
    return () => { cancelled = true }
  }, [cwd])
  return branch
}

function NavGroupHeader({
  label, collapsed, count, onToggle,
}: { label: string; collapsed: boolean; count: number; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      className="group w-full flex items-center gap-1.5 px-3 pt-3.5 pb-1.5 font-serif italic text-[11px] font-bold tracking-[0.07em] uppercase text-fg-faint hover:text-fg-dim transition-colors text-left"
    >
      <span
        aria-hidden
        className="inline-block w-2 text-[9px] not-italic transition-transform"
        style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
      >
        ▾
      </span>
      <span className="flex-1">{label}</span>
      {collapsed && (
        <span className="not-italic text-[10px] font-mono text-fg-faint/70 normal-case tracking-normal">
          {count}
        </span>
      )}
    </button>
  )
}

function NavRow({
  item, active, live, onClick, rail,
}: { item: NavGroupItem; active: boolean; live: boolean; onClick: () => void; rail: boolean }) {
  return (
    <button
      onClick={onClick}
      title={item.hint}
      className={`relative w-full flex items-center rounded-[10px] text-left mb-0.5 transition-colors ${
        rail ? 'justify-center px-0 py-[9px]' : 'gap-3 px-3.5 py-[9px] text-[14px]'
      } ${
        active
          ? 'bg-bg-hi text-fg font-semibold border border-line'
          : 'text-fg-dim hover:bg-bg-hi/50 hover:text-fg border border-transparent'
      }`}
    >
      {active && (
        <span
          aria-hidden
          className={`absolute top-3 bottom-3 w-[3px] rounded-sm bg-accent ${rail ? '-left-[4px]' : '-left-[10px]'}`}
        />
      )}
      <span className={`inline-flex ${active ? 'text-accent' : 'text-fg-faint'}`}>
        <AlmanacIcon name={item.icon} size={17} stroke={1.6} />
      </span>
      {!rail && <span className="flex-1 truncate">{item.label}</span>}
      {!rail && live && (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="live activity" />
      )}
      {rail && live && (
        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="live activity" />
      )}
    </button>
  )
}

function ToolRow({ tool, active, onClick, rail }: { tool: ToolItem; active: boolean; onClick: () => void; rail: boolean }) {
  return (
    <button
      onClick={onClick}
      title={tool.hint}
      className={`relative w-full flex items-center rounded-[10px] text-left mb-0.5 transition-colors ${
        rail ? 'justify-center px-0 py-[7px]' : 'gap-3 px-3.5 py-[7px] text-[13px]'
      } ${
        active
          ? 'bg-bg-hi text-fg font-semibold border border-line'
          : 'text-fg-dim hover:bg-bg-hi/50 hover:text-fg border border-transparent'
      }`}
    >
      {active && (
        <span
          aria-hidden
          className={`absolute top-2 bottom-2 w-[3px] rounded-sm bg-accent ${rail ? '-left-[4px]' : '-left-[10px]'}`}
        />
      )}
      <span className={`inline-flex ${active ? 'text-accent' : 'text-fg-faint'}`}>
        <AlmanacIcon name={tool.icon} size={15} stroke={1.6} />
      </span>
      {!rail && <span className="flex-1 truncate">{tool.label}</span>}
    </button>
  )
}

function SidebarFooter({ rail }: { rail: boolean }) {
  const isRecording = useVoice((s) => s.isRecording)
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const [model, setModel] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!activeTab?.presetId) { setModel(null); return }
    findPreset(activeTab.presetId)
      .then((p) => { if (!cancelled) setModel(p?.model ?? null) })
      .catch(() => { if (!cancelled) setModel(null) })
    return () => { cancelled = true }
  }, [activeTab?.presetId])

  if (rail) {
    return (
      <div className="py-2.5 border-t border-rule flex justify-center">
        <span
          className={`w-1.5 h-1.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-sage'}`}
          title={isRecording ? 'recording' : 'idle'}
        />
      </div>
    )
  }

  return (
    <div className="px-3.5 py-2.5 border-t border-rule flex items-center gap-2 text-[11.5px] text-fg-dim font-mono">
      <span
        className={`w-1.5 h-1.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-sage'}`}
        title={isRecording ? 'recording' : 'idle'}
      />
      <span className="truncate" title={model ?? ''}>
        {isRecording ? 'recording…' : (model ? `Claude · ${shortModel(model)}` : 'Claude Code')}
      </span>
    </div>
  )
}

function shortModel(m: string): string {
  // claude-opus-4-7 → Opus 4.7
  const lower = m.toLowerCase()
  if (lower.includes('opus')) {
    const v = m.match(/(\d+[-.]?\d*)/)?.[1]?.replace('-', '.')
    return v ? `Opus ${v}` : 'Opus'
  }
  if (lower.includes('sonnet')) {
    const v = m.match(/(\d+[-.]?\d*)/)?.[1]?.replace('-', '.')
    return v ? `Sonnet ${v}` : 'Sonnet'
  }
  if (lower.includes('haiku')) {
    const v = m.match(/(\d+[-.]?\d*)/)?.[1]?.replace('-', '.')
    return v ? `Haiku ${v}` : 'Haiku'
  }
  return m
}

