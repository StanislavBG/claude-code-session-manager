import { useCallback, useRef, useState } from 'react'
import { useSessions } from '../../state/sessions'
import { useEditor } from '../../state/editor'
import { FileTree } from '../layout/FileTree'
import { EditorView } from './EditorView'
import { compactPath } from '../../lib/compactPath'

const SPLIT_KEY = 'sm.projects.splitPct'
const SPLIT_DEFAULT = 33
const SPLIT_MIN = 20
const SPLIT_MAX = 60

function loadSplitPct(): number {
  try {
    const v = parseFloat(localStorage.getItem(SPLIT_KEY) ?? '')
    if (Number.isFinite(v)) return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
  } catch { /* ignore */ }
  return SPLIT_DEFAULT
}

export function ProjectsWorkspace() {
  const tabs = useSessions((s) => s.tabs)
  const activeTabId = useSessions((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const [pct, setPct] = useState<number>(() => loadSplitPct())
  const pctRef = useRef(pct)
  pctRef.current = pct
  const containerRef = useRef<HTMLDivElement>(null)

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

  return (
    <div ref={containerRef} className="flex h-full w-full" data-testid="projects-workspace">
      {/* Left pane — file tree */}
      <div
        className="shrink-0 flex flex-col border-r border-line overflow-hidden"
        style={{ width: `${pct}%` }}
        data-testid="projects-file-tree-pane"
      >
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
