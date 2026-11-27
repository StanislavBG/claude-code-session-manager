import { useEffect, useState } from 'react'
import { readUiSettingsPrefs, writeUiSettingsPrefs } from '../lib/uiSettingsPrefs'
import { openFreeHour } from '../lib/freeHour'
import { toast } from '../state/toast'

declare const __APP_VERSION__: string

/**
 * Quiet one-line invite shown to every user, inline above the window footer.
 * Dismissing it (or clicking the link) hides it for the current app version;
 * it returns at most once per new version. Hidden until the pref is read.
 */
export function ConsultationNotice() {
  const [loaded, setLoaded] = useState(false)
  const [dismissedVersion, setDismissedVersion] = useState<string | undefined>(undefined)
  const [hiddenNow, setHiddenNow] = useState(false)

  useEffect(() => {
    let cancelled = false
    readUiSettingsPrefs()
      .then((p) => {
        if (cancelled) return
        setDismissedVersion(p.consultationNoticeDismissedVersion)
        setLoaded(true)
      })
      .catch(() => {
        // A failed read shows the strip (nothing is known to be dismissed).
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!loaded || hiddenNow || dismissedVersion === __APP_VERSION__) return null

  const hide = () => {
    setHiddenNow(true)
    writeUiSettingsPrefs({ consultationNoticeDismissedVersion: __APP_VERSION__ }).catch(
      (e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e))
      },
    )
  }

  return (
    <div className="flex items-center justify-center gap-2 px-3 py-1 text-[12px] text-fg-dim border-t border-line">
      <span data-testid="consultation-notice">
        Want to chat?{' '}
        <button
          type="button"
          data-testid="consultation-notice-link"
          className="font-semibold text-accent hover:underline"
          onClick={() => {
            openFreeHour()
            hide()
          }}
        >
          Book a free consultation
        </button>
        .
      </span>
      <button
        type="button"
        data-testid="consultation-notice-dismiss"
        aria-label="Dismiss"
        className="text-fg-faint hover:text-fg"
        onClick={hide}
      >
        ×
      </button>
    </div>
  )
}
