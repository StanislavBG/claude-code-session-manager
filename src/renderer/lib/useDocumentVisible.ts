import { useEffect, useState } from 'react'

/**
 * True while the app window is visible (per the Page Visibility API). TabBar
 * lives outside Workbench/PanelFocusProvider entirely (App.tsx mounts it
 * once, above the panel tree), so it has no panel id to gate on — document
 * visibility is the closest available signal for "is anyone looking at
 * this app right now" for a component with that shape.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  )

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}
