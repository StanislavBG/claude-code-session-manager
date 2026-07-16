/**
 * FileTabBar — preview tabs strip above the terminal/preview area.
 *
 * Mirrors VS Code's open-files tab strip but is read-only (no dirty bit yet —
 * the DocumentViewer doesn't edit). Middle-click closes; right-click brings up
 * a tiny close/close-others/close-all menu.
 *
 * Layout: a single horizontally-scrolling row. The bar renders nothing when
 * `openFiles` is empty.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface OpenFile {
  path: string
  name: string
}

interface FileTabBarProps {
  openFiles: OpenFile[]
  activeFilePath: string | null
  /** path → has-unsaved-changes; renders a dirty dot in place of the close glyph. */
  dirty?: Record<string, boolean>
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
  onCloseOthers?: (path: string) => void
  onCloseToTheRight?: (path: string) => void
  onCloseAll?: () => void
}

export function FileTabBar({
  openFiles,
  activeFilePath,
  dirty,
  onSelectFile,
  onCloseFile,
  onCloseOthers,
  onCloseToTheRight,
  onCloseAll,
}: FileTabBarProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const handleContext = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, path })
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent, path: string) => {
    // middle-click closes the tab.
    if (e.button === 1) {
      e.preventDefault()
      onCloseFile(path)
    }
  }, [onCloseFile])

  if (openFiles.length === 0) return null

  return (
    <div className="relative shrink-0">
      <div className="flex items-center gap-0.5 px-2 py-1 bg-bg-elev border-b border-line overflow-x-auto">
        {openFiles.map((f) => {
          const isActive = f.path === activeFilePath
          return (
            <div
              key={f.path}
              onClick={() => onSelectFile(f.path)}
              onMouseDown={(e) => handleMouseDown(e, f.path)}
              onContextMenu={(e) => handleContext(e, f.path)}
              className={`
                group flex items-center gap-2 px-2 py-1 rounded text-xs cursor-pointer select-none shrink-0 max-w-[200px]
                ${isActive ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi/60'}
              `}
            >
              <span className="truncate">{f.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onCloseFile(f.path) }}
                className={`
                  relative p-0.5 rounded transition-opacity
                  ${isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70 hover:opacity-100'}
                  hover:bg-bg
                `}
                title={dirty?.[f.path] ? 'Unsaved changes — close' : 'Close'}
              >
                {dirty?.[f.path] ? (
                  // Dirty dot, swapped for the × on hover (VS Code convention).
                  <>
                    <span className="block w-2 h-2 rounded-full bg-accent group-hover:hidden" />
                    <span className="hidden group-hover:block"><CloseIcon size={10} /></span>
                  </>
                ) : (
                  <CloseIcon size={10} />
                )}
              </button>
            </div>
          )
        })}
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[300] w-44 rounded-lg border border-line bg-bg-elev shadow-xl text-xs py-1"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            onClick={() => { onCloseFile(menu.path); setMenu(null) }}
            className="w-full text-left px-3 py-1.5 text-fg-dim hover:text-fg hover:bg-bg-hi transition-colors"
          >
            Close
          </button>
          {onCloseOthers && openFiles.length > 1 && (
            <button
              onClick={() => { onCloseOthers(menu.path); setMenu(null) }}
              className="w-full text-left px-3 py-1.5 text-fg-dim hover:text-fg hover:bg-bg-hi transition-colors"
            >
              Close Others
            </button>
          )}
          {onCloseToTheRight && openFiles.findIndex((f) => f.path === menu.path) < openFiles.length - 1 && (
            <button
              onClick={() => { onCloseToTheRight(menu.path); setMenu(null) }}
              className="w-full text-left px-3 py-1.5 text-fg-dim hover:text-fg hover:bg-bg-hi transition-colors"
            >
              Close to the Right
            </button>
          )}
          {onCloseAll && (
            <button
              onClick={() => { onCloseAll(); setMenu(null) }}
              className="w-full text-left px-3 py-1.5 text-fg-dim hover:text-fg hover:bg-bg-hi transition-colors"
            >
              Close All
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function CloseIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
