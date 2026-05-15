import { useCallback, useEffect, useState } from 'react'

export type Density = 'compact' | 'roomy'

const STORAGE_KEY = 'sm.density'
const DEFAULT: Density = 'roomy'
const BODY_CLASS = 'density-compact'

function loadDensity(): Density {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'compact' || raw === 'roomy') return raw
  } catch {
    /* ignore */
  }
  return DEFAULT
}

function applyToBody(d: Density) {
  if (typeof document === 'undefined') return
  if (d === 'compact') document.body.classList.add(BODY_CLASS)
  else document.body.classList.remove(BODY_CLASS)
}

// Module-level singleton state + listener set so every useDensity() hook
// instance stays in sync across the tree without prop-drilling.
let current: Density = loadDensity()
const listeners = new Set<(d: Density) => void>()
applyToBody(current)

function setGlobalDensity(d: Density) {
  if (d === current) return
  current = d
  try { localStorage.setItem(STORAGE_KEY, d) } catch { /* ignore */ }
  applyToBody(d)
  listeners.forEach((fn) => fn(d))
}

export function useDensity(): { density: Density; setDensity: (d: Density) => void } {
  const [density, setLocal] = useState<Density>(current)
  useEffect(() => {
    const fn = (d: Density) => setLocal(d)
    listeners.add(fn)
    // Sync in case singleton changed between render and effect.
    if (current !== density) setLocal(current)
    return () => { listeners.delete(fn) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const setDensity = useCallback((d: Density) => setGlobalDensity(d), [])
  return { density, setDensity }
}
