/**
 * AlmanacSidebar — primary navigation. Replaces both the old top Header
 * (action toolbar) and the old LeftNav. Three nav groups (Workspace,
 * Configure, Tools), a Navigate/Files toggle, project caption, persistent
 * recording status in the footer, and a New Session primary button.
 *
 * Click handlers come in via props. Workspace + Configure items navigate via
 * `onNavigate(NavKey)` (these render as full pages in MainPane). Tools items
 * open existing modals via dedicated callbacks the same way the old Header
 * wired them, so no modal logic needs to change.
 *
 * Files mode mounts the existing FileTree rooted at the active tab's cwd.
 * Persisted to localStorage so the user's last mode is restored on launch.
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
import { FileTree } from './FileTree'
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

const MODE_KEY = 'sm.almanac.sidebarMode'
type Mode = 'nav' | 'files'

function loadMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v === 'files' ? 'files' : 'nav'
  } catch {
    return 'nav'
  }
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
  /** Open a file in the main-space Editor scene (and navigate there). */
  onOpenFile: (path: string) => void
}

export function AlmanacSidebar({ active, onNavigate, onNewSession, onOpenFile }: AlmanacSidebarProps) {
  const [mode, setMode] = useState<Mode>(() => loadMode())
  const setModePersist = useCallback((m: Mode) => {
    setMode(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* ignore */ }
  }, [])

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
      className="shrink-0 bg-bg-elev border-r border-line flex flex-col relative"
      style={{ width }}
      data-testid="tour-leftnav"
      aria-label="Primary navigation"
    >
      <ProjectCaption tab={activeTab} onNewSession={onNewSession} />

      {/* Navigate / Files toggle */}
      <div className="px-3.5 pt-3 pb-2 flex gap-1">
        {(['nav', 'files'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setModePersist(m)}
            aria-pressed={mode === m}
            className={`flex-1 py-1.5 rounded-md text-[12px] font-semibold tracking-[0.02em] transition-colors ${
              mode === m
                ? 'bg-bg-hi text-fg border border-line'
                : 'text-fg-faint hover:text-fg-dim border border-transparent'
            }`}
          >
            {m === 'nav' ? 'Navigate' : 'Files'}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-2 pb-3">
        {mode === 'nav' ? (
          <>
            <NavGroupHeader
              label="Workspace"
              collapsed={collapsed.has('Workspace')}
              count={WORKSPACE.length}
              onToggle={() => toggleGroup('Workspace')}
            />
            {!collapsed.has('Workspace') && WORKSPACE.map((item) => (
              <NavRow
                key={item.key}
                item={item}
                active={active === item.key}
                live={item.liveKind ? indicators[item.liveKind] : false}
                onClick={() => onNavigate(item.key)}
              />
            ))}

            <NavGroupHeader
              label="Configure"
              collapsed={collapsed.has('Configure')}
              count={CONFIGURE.length}
              onToggle={() => toggleGroup('Configure')}
            />
            {!collapsed.has('Configure') && CONFIGURE.map((item) => (
              <NavRow
                key={item.key}
                item={item}
                active={active === item.key}
                live={false}
                onClick={() => onNavigate(item.key)}
              />
            ))}

            <NavGroupHeader
              label="Tools"
              collapsed={collapsed.has('Tools')}
              count={TOOLS.length}
              onToggle={() => toggleGroup('Tools')}
            />
            {!collapsed.has('Tools') && TOOLS.map((tool) => (
              <ToolRow
                key={tool.key}
                tool={tool}
                active={active === tool.key}
                onClick={() => onNavigate(tool.key)}
              />
            ))}
          </>
        ) : (
          <FilesMode tab={activeTab} onOpenFile={onOpenFile} />
        )}
      </div>

      <SidebarFooter />

      {/* Drag-to-resize handle, straddling the right border. Double-click resets. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        className="absolute top-0 right-0 h-full w-1.5 translate-x-1/2 z-10 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />
    </aside>
  )
}

function ProjectCaption({ tab, onNewSession }: { tab: { cwd: string; label: string } | null; onNewSession: () => void }) {
  const name = tab?.label ?? 'no session'
  const branch = useBranch(tab?.cwd ?? null)
  return (
    <div className="px-[18px] pt-[14px] pb-[10px] border-b border-rule">
      <div className="text-[11px] font-semibold tracking-[0.06em] text-fg-faint uppercase">
        Project
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
  item, active, live, onClick,
}: { item: NavGroupItem; active: boolean; live: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={item.hint}
      className={`relative w-full flex items-center gap-3 px-3.5 py-[9px] rounded-[10px] text-left text-[14px] mb-0.5 transition-colors ${
        active
          ? 'bg-bg-hi text-fg font-semibold border border-line'
          : 'text-fg-dim hover:bg-bg-hi/50 hover:text-fg border border-transparent'
      }`}
    >
      {active && (
        <span
          aria-hidden
          className="absolute -left-[10px] top-3 bottom-3 w-[3px] rounded-sm bg-accent"
        />
      )}
      <span className={`inline-flex ${active ? 'text-accent' : 'text-fg-faint'}`}>
        <AlmanacIcon name={item.icon} size={17} stroke={1.6} />
      </span>
      <span className="flex-1 truncate">{item.label}</span>
      {live && (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="live activity" />
      )}
    </button>
  )
}

function ToolRow({ tool, active, onClick }: { tool: ToolItem; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={tool.hint}
      className={`relative w-full flex items-center gap-3 px-3.5 py-[7px] rounded-[10px] text-left text-[13px] mb-0.5 transition-colors ${
        active
          ? 'bg-bg-hi text-fg font-semibold border border-line'
          : 'text-fg-dim hover:bg-bg-hi/50 hover:text-fg border border-transparent'
      }`}
    >
      {active && (
        <span
          aria-hidden
          className="absolute -left-[10px] top-2 bottom-2 w-[3px] rounded-sm bg-accent"
        />
      )}
      <span className={`inline-flex ${active ? 'text-accent' : 'text-fg-faint'}`}>
        <AlmanacIcon name={tool.icon} size={15} stroke={1.6} />
      </span>
      <span className="flex-1 truncate">{tool.label}</span>
    </button>
  )
}

function FilesMode({ tab, onOpenFile }: { tab: { id: string; cwd: string } | null; onOpenFile: (path: string) => void }) {
  if (!tab) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-fg-faint">
        No session selected.
      </div>
    )
  }
  return (
    <div className="pt-1">
      <div className="px-3 pb-2 text-[11.5px] text-fg-faint font-mono truncate" title={tab.cwd}>
        {compactPath(tab.cwd)}
      </div>
      <FileTree cwd={tab.cwd} activeTabId={tab.id} onPreviewFile={onOpenFile} />
    </div>
  )
}

function compactPath(p: string): string {
  const home = '/home/'
  if (p.startsWith(home)) {
    const tail = p.slice(home.length).split('/').slice(1).join('/')
    return tail ? `~/${tail}` : '~'
  }
  return p
}

function SidebarFooter() {
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

