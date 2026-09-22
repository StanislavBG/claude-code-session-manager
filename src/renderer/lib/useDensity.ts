import { useCallback, useEffect } from 'react'
import { useUiChromePrefs, type Density } from '../state/uiChromePrefs'

export type { Density }

const BODY_CLASS = 'density-compact'

function applyToBody(d: Density) {
  if (typeof document === 'undefined') return
  if (d === 'compact') document.body.classList.add(BODY_CLASS)
  else document.body.classList.remove(BODY_CLASS)
}

// Module-level once-flag: the body class must react to every density change
// regardless of how many useDensity() instances are mounted, but should only
// be wired up once.
let subscribed = false
function ensureBodyClassSubscription() {
  if (subscribed) return
  subscribed = true
  applyToBody(useUiChromePrefs.getState().density)
  useUiChromePrefs.subscribe((s) => applyToBody(s.density))
}

export function useDensity(): { density: Density; setDensity: (d: Density) => void } {
  ensureBodyClassSubscription()
  const hydrated = useUiChromePrefs((s) => s.hydrated)
  const hydrate = useUiChromePrefs((s) => s.hydrate)
  useEffect(() => {
    if (!hydrated) hydrate()
  }, [hydrated, hydrate])

  const density = useUiChromePrefs((s) => s.density)
  const setDensityPref = useUiChromePrefs((s) => s.setDensity)
  const setDensity = useCallback((d: Density) => setDensityPref(d), [setDensityPref])
  return { density, setDensity }
}
