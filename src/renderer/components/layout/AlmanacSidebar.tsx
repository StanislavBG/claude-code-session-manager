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
import { useLayout } from '../../state/layout'
import { useVoice } from '../../state/voice'
import { useScheduleState } from '../../state/scheduleState'
import { useBilling } from '../../state/billing'
import { findPreset } from '../../lib/presets'
import { AlmanacIcon, type AlmanacIconName } from './AlmanacIcon'
import { prettyModel } from '../../lib/prettyModel'
import { useBranch } from '../../lib/useBranch'
import { NAV_GROUP_DESCRIPTIONS, getNavItemsForFace, type NavGroupItem } from '../../lib/navGroups'
import type { NavFace } from '../../lib/navFace'

// v0.13.1 — Tools are now full pages too. We still keep them in a separate
// group below Configure so users see them as workflow surfaces (not
// configuration). Same NavKey type as Workspace/Configure rows.
type ToolKey = Extract<NavKey,
  | 'voice' | 'repoviz' | 'search'
>
void useBilling; void useMemo // (kept for future signal additions)

interface ToolItem {
  key: ToolKey
  label: string
  icon: AlmanacIconName
  hint?: string
}

function toolItems(items: NavGroupItem[]): ToolItem[] {
  return items
    .filter((item): item is NavGroupItem & { key: ToolKey } => item.group === 'Tools')
    .map(({ key, label, icon, hint }) => ({ key, label, icon, hint }))
}

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
  // Scheduler is a browser over TAB → EPIC → PRD (CLAUDE.md domain model), so
  // the nav dot reports the ACTIVE TAB's project only — a job running in some
  // other project must not light up this project's row. Falls back to
  // machine-wide when there's no active tab, matching the Scheduler tab's own
  // scope toggle ("No active tab — showing all projects").
  //
  // Both selectors return primitives (a cwd string and a boolean) so this
  // component re-renders only when the value actually flips, not on every
  // scheduler snapshot broadcast — and never returns a freshly-built array,
  // which would infinite-loop under zustand v5 (see CLAUDE.md "Avoid").
  const activeCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)
  const schedulerRunning = useScheduleState((s) =>
    (s.snapshot?.jobs ?? []).some(
      (j) => j.status === 'running' && (!activeCwd || j.cwd === activeCwd),
    ),
  )
  return {
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

  const navFace: NavFace = useLayout((s) => s.navFace)
  const items = getNavItemsForFace(navFace)
  const workspace = items.filter((item) => item.group === 'Workspace')
  const configure = items.filter((item) => item.group === 'Configure')
  const tools = toolItems(items)

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
      <ProjectCaption tab={activeTab} navFace={navFace} onNewSession={onNewSession} rail={rail} onToggleRail={toggleRail} />

      <div className="flex-1 min-h-0 overflow-auto pb-3" style={{ paddingInline: rail ? '4px' : '8px' }}>
        <>
          {!rail && (
            <NavGroupHeader
              label="Workspace"
              desc={NAV_GROUP_DESCRIPTIONS.Workspace}
              collapsed={collapsed.has('Workspace')}
              count={workspace.length}
              onToggle={() => toggleGroup('Workspace')}
            />
          )}
          {(rail || !collapsed.has('Workspace')) && workspace.map((item) => (
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
              desc={NAV_GROUP_DESCRIPTIONS.Configure}
              collapsed={collapsed.has('Configure')}
              count={configure.length}
              onToggle={() => toggleGroup('Configure')}
            />
          )}
          {(rail || !collapsed.has('Configure')) && configure.map((item) => (
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
              desc={NAV_GROUP_DESCRIPTIONS.Tools}
              collapsed={collapsed.has('Tools')}
              count={tools.length}
              onToggle={() => toggleGroup('Tools')}
            />
          )}
          {(rail || !collapsed.has('Tools')) && tools.map((tool) => (
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

      <SidebarFooter rail={rail} navFace={navFace} />

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
  tab, navFace, onNewSession, rail, onToggleRail,
}: {
  tab: { cwd: string; label: string } | null
  navFace: NavFace
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
          title="Open / Start Project"
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

  if (navFace === 'home') {
    return (
      <div className="px-[18px] pt-[14px] pb-[10px] border-b border-rule">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold tracking-[0.06em] text-fg-faint uppercase">
            Session Manager
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
        <div className="mt-3 flex items-stretch gap-1.5">
          <button
            onClick={onNewSession}
            data-testid="tour-new-session"
            className="flex-1 px-3 py-1.5 rounded-md bg-bg-hi border border-line text-fg text-[12.5px] font-medium hover:bg-bg-hi/80 hover:border-accent/40 transition-colors flex items-center justify-center gap-1.5"
          >
            <AlmanacIcon name="plus" size={13} stroke={1.8} />
            Open / Start Project
          </button>
        </div>
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
          Open / Start Project
        </button>
      </div>
    </div>
  )
}

function NavGroupHeader({
  label, desc, collapsed, count, onToggle,
}: { label: string; desc: string; collapsed: boolean; count: number; onToggle: () => void }) {
  return (
    <div className="px-3 pt-3.5 pb-1.5">
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
        className="group w-full flex items-center gap-1.5 font-serif italic text-[11px] font-bold tracking-[0.07em] uppercase text-fg-faint hover:text-fg-dim transition-colors text-left"
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
      {!collapsed && (
        <p className="mt-0.5 pl-3.5 text-[11px] leading-[1.35] text-fg-faint/80 normal-case tracking-normal font-sans not-italic line-clamp-2">
          {desc}
        </p>
      )}
    </div>
  )
}

function NavRow({
  item, active, live, onClick, rail,
}: { item: NavGroupItem; active: boolean; live: boolean; onClick: () => void; rail: boolean }) {
  return (
    <button
      onClick={onClick}
      title={item.hint}
      data-testid={item.key === 'scheduler' ? 'tour-scheduler' : undefined}
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
          className={`absolute top-2 bottom-2 w-[3px] rounded-sm bg-accent ${rail ? '-left-[4px]' : '-left-[10px]'}`}
        />
      )}
      <span className={`inline-flex ${active ? 'text-accent' : 'text-fg-faint'}`}>
        <AlmanacIcon name={item.icon} size={17} stroke={1.6} />
      </span>
      {!rail && (
        <span className="flex-1 min-w-0">
          <span className="block truncate">{item.label}</span>
          {item.hint && (
            <span className="block text-[11px] leading-[1.3] text-fg-faint/80 font-normal truncate">
              {item.hint}
            </span>
          )}
        </span>
      )}
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
          className={`absolute top-1.5 bottom-1.5 w-[3px] rounded-sm bg-accent ${rail ? '-left-[4px]' : '-left-[10px]'}`}
        />
      )}
      <span className={`inline-flex ${active ? 'text-accent' : 'text-fg-faint'}`}>
        <AlmanacIcon name={tool.icon} size={15} stroke={1.6} />
      </span>
      {!rail && (
        <span className="flex-1 min-w-0">
          <span className="block truncate">{tool.label}</span>
          {tool.hint && (
            <span className="block text-[11px] leading-[1.3] text-fg-faint/80 font-normal truncate">
              {tool.hint}
            </span>
          )}
        </span>
      )}
    </button>
  )
}

function SidebarFooter({ rail, navFace }: { rail: boolean; navFace: NavFace }) {
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
      {(isRecording || navFace === 'project') && (
        <span className="truncate" title={model ?? ''}>
          {isRecording ? 'recording…' : (model ? `Claude · ${prettyModel(model)}` : 'Claude Code')}
        </span>
      )}
    </div>
  )
}

