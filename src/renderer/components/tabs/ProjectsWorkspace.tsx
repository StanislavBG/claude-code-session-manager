import { useCallback, useRef, useState, useEffect } from 'react'
import { useSessions } from '../../state/sessions'
import { useEditor } from '../../state/editor'
import { useProjectsPrefs } from '../../state/projectsPrefs'
import { useKnownProjects, candidatePath } from '../../lib/useKnownProjects'
import { FileTree } from '../layout/FileTree'
import { EditorView } from './EditorView'
import { Tooltip } from '../ui/Tooltip'
import { compactPath } from '../../lib/compactPath'

const SPLIT_KEY = 'sm.projects.splitPct'
const SPLIT_DEFAULT = 33
const SPLIT_MIN = 20
const SPLIT_MAX = 60

const COLLAPSED_KEY = 'sm.projects.fileTreeCollapsed'
const RAIL_WIDTH = 32

function loadSplitPct(): number {
  try {
    const v = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '')
    if (Number.isFinite(v)) return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
  } catch { /* ignore */ }
  return SPLIT_DEFAULT
}

function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

export function ProjectsWorkspace() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const [pct, setPct] = useState<number>(() => loadSplitPct())
  const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsed())
  const [launcherOpen, setLauncherOpen] = useState(false)
  const pctRef = useRef(pct)
  pctRef.current = pct
  const containerRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLDivElement>(null)

  const { rows, enriched, openInSession, archiveProject } = useKnownProjects()
  const pinned = useProjectsPrefs((s) => s.pinned)
  const togglePin = useProjectsPrefs((s) => s.togglePin)

  const sortedRows = [...rows].sort((a, b) =>
    (pinned[b.encoded] ? 1 : 0) - (pinned[a.encoded] ? 1 : 0))

  useEffect(() => {
    if (!launcherOpen) return
    const handler = (e: MouseEvent) => {
      if (launcherRef.current && !launcherRef.current.contains(e.target as Node)) {
        setLauncherOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [launcherOpen])

  const openInline = useCallback((path: string) => {
    useEditor.getState().openFile(path)
  }, [])

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startPct = pctRef.current
    let lastPct = startPct
    const onMove = (ev: PointerEvent) => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const delta = ev.clientX - startX
      lastPct = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, startPct + (delta / rect.width) * 100))
      setPct(lastPct)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem(SPLIT_KEY, String(lastPct)) } catch { /* ignore */ }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  const resetSplit = useCallback(() => {
    setPct(SPLIT_DEFAULT)
    try { localStorage.setItem(SPLIT_KEY, String(SPLIT_DEFAULT)) } catch { /* ignore */ }
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((v) => {
      const next = !v
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }, [])

  if (collapsed) {
    return (
      <div ref={containerRef} className="flex h-full w-full" data-testid="projects-workspace">
        {/* Collapsed rail — click to restore the file explorer */}
        <button
          onClick={toggleCollapsed}
          data-testid="projects-file-tree-rail-toggle"
          title="Show file explorer"
          className="shrink-0 flex flex-col items-center gap-2 py-2 border-r border-line text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors"
          style={{ width: RAIL_WIDTH }}
        >
          <span className="text-[11px]">▸</span>
          <span className="text-[10px] tracking-wide [writing-mode:vertical-rl]">Files</span>
        </button>
        <div className="flex-1 min-w-0" data-testid="projects-editor-pane">
          <EditorView />
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full w-full" data-testid="projects-workspace">
      {/* Left pane — file tree */}
      <div
        className="shrink-0 flex flex-col border-r border-line overflow-hidden"
        style={{ width: `${pct}%` }}
        data-testid="projects-file-tree-pane"
      >
        {/* Compact project launcher — always visible */}
        <div ref={launcherRef} className="relative shrink-0 flex items-stretch border-b border-line">
          <button
            data-testid="projects-launcher-trigger"
            onClick={() => setLauncherOpen((v) => !v)}
            className="flex-1 min-w-0 px-3 py-1.5 text-[11.5px] text-fg-dim font-mono flex items-center gap-1 hover:bg-bg-hi transition-colors"
          >
            <span className="flex-1 truncate text-left">
              {activeTab ? compactPath(activeTab.cwd) : 'Projects'}
            </span>
            <span className="text-fg-faint shrink-0 text-[10px]">{launcherOpen ? '▲' : '▼'}</span>
          </button>
          <button
            onClick={toggleCollapsed}
            data-testid="projects-file-tree-collapse"
            title="Hide file explorer"
            className="shrink-0 px-2 border-l border-line text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors text-[11px]"
          >
            ◂
          </button>
          {launcherOpen && (
            <div
              data-testid="projects-launcher-list"
              className="absolute left-0 right-0 top-full z-50 bg-bg-elev border border-line shadow-lg max-h-60 overflow-auto"
            >
              {sortedRows.length === 0 ? (
                <div className="px-3 py-2 text-[11.5px] text-fg-faint">No projects found.</div>
              ) : (
                sortedRows.map((row) => {
                  const label = compactPath(enriched[row.encoded]?.cwd ?? candidatePath(row.encoded))
                  return (
                    <div key={row.encoded} data-testid="projects-launcher-row" className="flex items-center gap-1 px-2 py-1 hover:bg-bg-hi group">
                      <Tooltip content={pinned[row.encoded] ? 'Unpin' : 'Pin to top'}>
                        <button
                          onClick={() => togglePin(row.encoded)}
                          className={`shrink-0 text-sm leading-none transition-colors ${
                            pinned[row.encoded] ? 'text-yellow-400' : 'text-fg-faint hover:text-fg-dim'
                          }`}
                        >
                          {pinned[row.encoded] ? '★' : '☆'}
                        </button>
                      </Tooltip>
                      <button
                        onClick={() => { openInSession(row); setLauncherOpen(false) }}
                        className="flex-1 min-w-0 text-left text-[11.5px] font-mono truncate text-fg-dim hover:text-fg"
                      >
                        {label}
                      </button>
                      <button
                        onClick={async () => {
                          if (!window.confirm(`Archive ${label}?`)) return
                          await archiveProject(row.encoded)
                        }}
                        className="shrink-0 text-[10px] text-fg-faint hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Archive"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {activeTab ? (
          <>
            <div className="px-3 py-2 border-b border-line text-[11.5px] text-fg-faint font-mono truncate shrink-0" title={activeTab.cwd}>
              {compactPath(activeTab.cwd)}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              <FileTree cwd={activeTab.cwd} activeTabId={activeTab.id} onPreviewFile={openInline} />
            </div>
          </>
        ) : (
          <div className="px-3 py-6 text-center text-[12px] text-fg-faint">
            No session selected.
          </div>
        )}
      </div>

      {/* Drag divider */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={resetSplit}
        className="w-1.5 shrink-0 cursor-col-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
      />

      {/* Right pane — editor */}
      <div className="flex-1 min-w-0" data-testid="projects-editor-pane">
        <EditorView />
      </div>
    </div>
  )
}
