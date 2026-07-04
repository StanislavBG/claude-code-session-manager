import { useCallback, useEffect, useState } from 'react'

export type RawModel = 'opus' | 'sonnet' | 'haiku'

export const RAW_MODELS: RawModel[] = ['opus', 'sonnet', 'haiku']

const STORAGE_KEY = 'sm.rawSessionModel'
const DEFAULT: RawModel = 'opus'

export function isRawModel(x: string): x is RawModel {
  return (RAW_MODELS as string[]).includes(x)
}

function loadRawSessionModel(): RawModel {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && isRawModel(raw)) return raw
  } catch {
    /* ignore */
  }
  return DEFAULT
}

// Module-level singleton state + listener set so every useRawSessionModel()
// hook instance stays in sync across the tree without prop-drilling.
let current: RawModel = loadRawSessionModel()
const listeners = new Set<(m: RawModel) => void>()

export function getRawSessionModel(): RawModel {
  return current
}

export function setRawSessionModel(m: RawModel): void {
  if (m === current) return
  current = m
  try { localStorage.setItem(STORAGE_KEY, m) } catch { /* ignore */ }
  listeners.forEach((fn) => fn(m))
}

export function useRawSessionModel(): { model: RawModel; setModel: (m: RawModel) => void } {
  const [model, setLocal] = useState<RawModel>(current)
  useEffect(() => {
    const fn = (m: RawModel) => setLocal(m)
    listeners.add(fn)
    // Sync in case singleton changed between render and effect.
    if (current !== model) setLocal(current)
    return () => { listeners.delete(fn) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const setModel = useCallback((m: RawModel) => setRawSessionModel(m), [])
  return { model, setModel }
}
