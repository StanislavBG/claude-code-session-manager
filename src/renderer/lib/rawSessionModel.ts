import { useCallback, useEffect, useState } from 'react'
import { readUiSettingsPrefs, writeUiSettingsPrefs } from './uiSettingsPrefs'
import { toast } from '../state/toast'

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

const DEFAULT: RawModel = 'opus'

/** True for a plausible model alias/id (bounded, no whitespace or shell-hostile chars). */
export function isRawModel(x: string): x is RawModel {
  return /^[A-Za-z0-9][A-Za-z0-9._\-]{0,79}(\[[0-9a-z]{1,4}\])?$/.test(x)
}

// Module-level singleton state + listener set so every useRawSessionModel()
// hook instance stays in sync across the tree without prop-drilling. `current`
// starts at DEFAULT and is updated once `hydrate()` resolves — sessions.ts's
// resolveStartupCommand launches a session off this synchronous cache rather
// than awaiting the IPC read itself (mirrors useKnownProjects.ts's
// cache-then-refresh pattern: a hot path never blocks on disk).
let current: RawModel = DEFAULT
const listeners = new Set<(m: RawModel) => void>()
// True once a user action has set a value — guards `hydrate()`'s disk read
// (fired at module load) from overwriting a choice the user already made
// while that read was still in flight.
let userSet = false

async function hydrate(): Promise<void> {
  try {
    const prefs = await readUiSettingsPrefs()
    if (userSet) return
    if (typeof prefs.rawSessionModel === 'string' && isRawModel(prefs.rawSessionModel)) {
      current = prefs.rawSessionModel
      listeners.forEach((fn) => fn(current))
    }
  } catch {
    /* ignore — stays at DEFAULT */
  }
}

void hydrate()

export function getRawSessionModel(): RawModel {
  return current
}

export function setRawSessionModel(m: RawModel): void {
  userSet = true
  if (m === current) return
  const previous = current
  current = m
  listeners.forEach((fn) => fn(m))
  writeUiSettingsPrefs({ rawSessionModel: m }).catch(() => {
    // Persist failed — revert so the UI doesn't show a choice that never
    // reached disk, and tell the user (CLAUDE.md: never swallow errors).
    current = previous
    listeners.forEach((fn) => fn(current))
    toast.error("Couldn't save the default model — reverted.")
  })
}

export function useRawSessionModel(): { model: RawModel; setModel: (m: RawModel) => void } {
  const [model, setLocal] = useState<RawModel>(current)
  useEffect(() => {
    const fn = (m: RawModel) => setLocal(m)
    listeners.add(fn)
    // Sync in case singleton changed between render and effect.
    if (current !== model) setLocal(current)
    return () => { listeners.delete(fn) }
  }, [])
  const setModel = useCallback((m: RawModel) => setRawSessionModel(m), [])
  return { model, setModel }
}
