/**
 * PluginMenu — the ⋯ menu on a plugin's detail header (Claude config ▸ Plugins, render 14):
 * Reveal in File Explorer, Copy path, divider, then Uninstall.
 *
 * Uninstall confirms inline inside the menu (design-mocks/claude-config, render 14) — never a native
 * `window.confirm`.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PluginRow } from '../../../lib/pluginContents'
import { revealInFileExplorer } from '../../../lib/revealInFileExplorer'
import { copyText } from '../../../lib/clipboard'
import { Z } from '../../../lib/zLayers'
import { toast } from '../../../state/toast'

export interface PluginMenuProps {
  row: PluginRow
  /** True while this plugin's enable or uninstall call is in flight. */
  busy: boolean
  /** Runs the uninstall; the menu has already confirmed it. */
  onUninstall: (row: PluginRow) => void
}

/** The ⋯ menu: Reveal in File Explorer, Copy path, divider, then Uninstall with its inline confirm. */
export function PluginMenu({ row, busy, onUninstall }: PluginMenuProps) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // Closing always drops a pending confirm, so the menu reopens on its item list.
  const close = useCallback(() => {
    setOpen(false)
    setConfirming(false)
  }, [])

  // Escape or a mousedown outside the trigger + menu closes it (same rule as ExtensionsToolbar).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const reveal = () => {
    close()
    revealInFileExplorer(row.path)
  }
  const copyPath = async () => {
    close()
    if (!(await copyText(row.path))) toast.error(`Could not copy ${row.path} to the clipboard`)
  }
  const confirmUninstall = () => {
    close()
    onUninstall(row)
  }

  const item = 'px-2.5 py-[7px] rounded-[5px] text-left whitespace-nowrap hover:bg-bg-elev'

  return (
    <div ref={wrapRef} className="relative self-start">
      <button
        type="button"
        data-testid="plugin-menu"
        aria-label={`Actions for ${row.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className="w-[30px] h-7 inline-flex items-center justify-center bg-bg border border-line rounded-md text-fg-dim hover:border-rule"
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${row.name}`}
          className={`absolute ${Z.dialog} right-0 top-[34px] w-[210px] p-[5px] flex flex-col bg-bg-hi border border-line rounded-lg shadow-lg text-[12.5px] text-fg`}
        >
          {confirming ? (
            <div className="flex flex-col gap-2 px-2.5 py-[7px]">
              <span className="font-medium">Uninstall {row.name}?</span>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  role="menuitem"
                  data-testid="plugin-uninstall"
                  disabled={busy}
                  onClick={confirmUninstall}
                  className="h-6 px-2.5 rounded-[5px] bg-delta-bad text-bg-hi font-medium hover:bg-delta-bad/90 disabled:opacity-40"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setConfirming(false)}
                  className="h-6 px-2.5 rounded-[5px] border border-line text-fg-dim hover:bg-bg-elev"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={reveal} className={item}>
                Reveal in File Explorer
              </button>
              <button type="button" role="menuitem" onClick={() => void copyPath()} className={item}>
                Copy path
              </button>
              <div role="separator" className="h-px mx-1.5 my-1 bg-line" />
              <button
                type="button"
                role="menuitem"
                disabled={!row.marketplace || busy}
                title={row.marketplace ? undefined : 'No marketplace is recorded for this install'}
                onClick={() => setConfirming(true)}
                className={`${item} font-medium text-delta-bad hover:bg-delta-bad/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
              >
                Uninstall {row.name}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
