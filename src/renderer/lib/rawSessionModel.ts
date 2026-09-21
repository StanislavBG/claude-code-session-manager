import { useCallback, useEffect, useState } from 'react'

/** Any alias (`opus`, `opus[1m]`) or concrete id (`claude-opus-5`) the CLI's `--model` accepts. */
export type RawModel = string

/** Fallback/default option list — used whenever the live catalog is unavailable. */
export const RAW_MODELS: RawModel[] = ['opus', 'sonnet', 'haiku', 'fable']

const CONTEXT_SUFFIX = '[1m]'

/**
 * Option list for the raw-terminal picker: catalog aliases + concrete ids, each also
 * offered with the `[1m]` suffix. `catalog === null` → exactly RAW_MODELS.
 * O(n) over the catalog lists.
 */
export function rawModelOptions(catalog: { aliases: readonly string[]; models: readonly string[] } | null): RawModel[] {
  if (!catalog) return RAW_MODELS
  const base = [...catalog.aliases, ...catalog.models]
  const out: string[] = []
  for (const m of base) out.push(m, m + CONTEXT_SUFFIX)
  return [...new Set(out)]
}

const STORAGE_KEY = 'sm.rawSessionModel'
const DEFAULT: RawModel = 'opus'

/** True for a plausible model alias/id (bounded, no whitespace or shell-hostile chars). */
export function isRawModel(x: string): x is RawModel {
  return /^[A-Za-z0-9][A-Za-z0-9._\-]{0,79}(\[[0-9a-z]{1,4}\])?$/.test(x)
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
