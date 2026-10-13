import { useEffect } from 'react'
import { Z } from '../../../../lib/zLayers'

interface Props {
  message: string | null
  onUndo?: () => void
  onClose: () => void
}

const AUTO_CLOSE_MS = 6000

export function UndoBar({ message, onUndo, onClose }: Props) {
  useEffect(() => {
    if (message === null) return
    const t = setTimeout(onClose, AUTO_CLOSE_MS)
    return () => clearTimeout(t)
    // onClose identity must not restart the timer; only a new message does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message])

  if (message === null) return null

  return (
    <div
      data-testid="mx-undo-bar"
      className={`absolute bottom-[22px] left-1/2 -translate-x-1/2 ${Z.dialog} flex items-center gap-[14px] py-[10px] pl-4 pr-3 rounded-lg bg-fg text-bg text-[13px] shadow-lg whitespace-nowrap`}
    >
      <span>{message}</span>
      {onUndo && (
        <button type="button" data-testid="mx-undo" onClick={onUndo} className="font-semibold text-accent-muted hover:text-white">
          Undo
        </button>
      )}
      <button type="button" onClick={onClose} aria-label="Dismiss" className="text-fg-faint hover:text-white px-1">
        ×
      </button>
    </div>
  )
}
