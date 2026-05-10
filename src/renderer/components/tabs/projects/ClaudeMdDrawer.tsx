import { useEffect, useRef, useState } from 'react'
import { EmptyState } from '../../ui/EmptyState'
import { MarkdownEditor } from '../../ui/MarkdownEditor'

interface Props {
  cwd: string
  projectName: string
  onClose: () => void
}

export function ClaudeMdDrawer({ cwd, projectName, onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    setText(null)
    window.api.config.readText(`${cwd}/CLAUDE.md`).then((r) => {
      setText(r.exists && r.text ? r.text : null)
      setLoading(false)
    }).catch(() => {
      setText(null)
      setLoading(false)
    })
  }, [cwd])

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [onClose])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === backdropRef.current) onClose()
  }

  return (
    // Invisible backdrop that catches outside clicks
    <div
      ref={backdropRef}
      className="absolute inset-0 z-20"
      onClick={handleBackdropClick}
    >
      <div
        className="absolute right-0 top-0 bottom-0 w-2/5 bg-bg-elev border-l border-line shadow-2xl z-30 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line bg-bg-elev">
          <div className="flex-1 min-w-0">
            <div className="text-fg text-xs font-medium truncate">{projectName}</div>
            <div className="text-fg-faint text-[10px] font-mono truncate">{cwd}/CLAUDE.md</div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-fg-faint hover:text-fg px-1.5 py-0.5 rounded hover:bg-bg-hi text-xs"
            title="Close (Escape)"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <EmptyState title="loading…" />
          ) : text == null ? (
            <EmptyState title="No CLAUDE.md found" />
          ) : (
            <MarkdownEditor
              value={text}
              onChange={() => {}}
              path={`${cwd}/CLAUDE.md`}
              readOnly
            />
          )}
        </div>
      </div>
    </div>
  )
}
