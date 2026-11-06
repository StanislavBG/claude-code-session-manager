// The app's single source for the free-hour booking link (a plain link, nothing more).
// Callers: the Feedback panel link, and the Help menu via the 'app:open-free-hour' event.
// Desktop opens it in the system browser through shell:open; the web build (where
// shell:open is denied) opens a new browser tab instead.
// The README carries the same link with utm_medium=readme.
import { toast } from '../state/toast'
import { isWebRemote } from '../state/epicTerminal'

export const FREE_HOUR_URL = 'https://bilko.run/book?utm_source=session-manager&utm_medium=app'

export function openFreeHour(): void {
  const failed = (): void => {
    toast.error(`Couldn't open URL: ${FREE_HOUR_URL}`)
  }
  if (isWebRemote()) {
    // No 'noopener' feature: it makes window.open return null even on success,
    // hiding a blocked popup. Sever the opener by hand instead.
    const opened = window.open(FREE_HOUR_URL, '_blank')
    if (!opened) {
      failed()
      return
    }
    try {
      opened.opener = null
    } catch {
      /* cross-origin window: nothing to sever */
    }
    return
  }
  window.api.shell
    .open({ as: 'external', url: FREE_HOUR_URL })
    .then((r) => {
      if (r?.ok === false) failed()
    })
    .catch(failed)
}
