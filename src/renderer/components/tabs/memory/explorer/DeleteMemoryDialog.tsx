import { useEffect } from 'react'
import { Z } from '../../../../lib/zLayers'

interface Props {
  open: boolean
  name: string
  inbound: number
  onArchive: () => void
  onCancel: () => void
  onConfirm: () => void
}

const BTN = 'text-[12.5px] font-medium h-8 px-3 rounded-[5px] cursor-pointer text-fg'

export function DeleteMemoryDialog({ open, name, inbound, onArchive, onCancel, onConfirm }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div data-testid="mx-delete-dialog">
      <div className={`absolute inset-0 ${Z.dialog} bg-fg/30`} onClick={onCancel} />
      <div
        className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] ${Z.dialog} bg-bg-hi border border-rule rounded-[10px] shadow-lg p-5 flex flex-col gap-3`}
      >
        <span className="font-serif text-[20px] text-fg">Delete this memory?</span>
        <span className="font-mono text-[12.5px] text-fg">{name}.md</span>
        {inbound > 0 && (
          <div className="px-3 py-[10px] rounded-[6px] bg-accent-muted/30 text-[12.5px] leading-normal text-accent-dark">
            {inbound} memories link here. Those links will show as broken until removed.
          </div>
        )}
        <span className="text-[12.5px] text-fg-dim">
          The file is removed from disk. You can undo for a few seconds afterwards. To keep it out of sessions
          without deleting it, use Archive.
        </span>
        <div className="flex gap-2 justify-end mt-1">
          <button type="button" onClick={onArchive} className={`${BTN} border border-rule mr-auto`}>
            Archive instead
          </button>
          <button type="button" onClick={onCancel} className={`${BTN} border border-rule bg-bg`}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="mx-delete-confirm"
            onClick={onConfirm}
            className={`${BTN} border-0 px-[14px] bg-accent text-white`}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
