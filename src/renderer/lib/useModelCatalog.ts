/**
 * useModelCatalog(cwd) — the renderer half of the live model/effort catalog
 * (models:catalog → src/main/lib/modelCatalog.cjs). Module-scope per-cwd cache so
 * every component mounting it for one cwd shares a single IPC round-trip. Never
 * throws: an IPC failure degrades to `catalog: null` (consumers use their own
 * static fallback) and is not cached, so the next mount retries. Fresh-on-mount
 * plus an explicit refresh() is the whole refresh policy — no watcher, no timer.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../state/toast'

export type ModelCatalog = Awaited<ReturnType<Window['api']['models']['catalog']>>

interface Entry {
  catalog: ModelCatalog | null
  promise: Promise<ModelCatalog | null> | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<(key: string) => void>()

function keyOf(cwd: string | null): string {
  return cwd ?? ''
}

function entryFor(key: string): Entry {
  let e = entries.get(key)
  if (!e) {
    e = { catalog: null, promise: null }
    entries.set(key, e)
  }
  return e
}

/** One invoke per key at a time; a caller arriving mid-flight shares the promise. */
function load(cwd: string | null, force: boolean): Promise<ModelCatalog | null> {
  const key = keyOf(cwd)
  const e = entryFor(key)
  if (e.promise) return e.promise
  if (!force && e.catalog) return Promise.resolve(e.catalog)
  const payload: { cwd?: string; force?: boolean } = {}
  if (cwd) payload.cwd = cwd
  if (force) payload.force = true
  const p: Promise<ModelCatalog | null> = Promise.resolve()
    .then(() => window.api.models.catalog(payload))
    .then(
      (result) => {
        e.promise = null
        if (result) e.catalog = result
        listeners.forEach((l) => l(key))
        return result ?? null
      },
      () => {
        e.promise = null
        return null
      }
    )
  e.promise = p
  return p
}

export function useModelCatalog(cwd: string | null): {
  catalog: ModelCatalog | null
  loading: boolean
  degraded: boolean
  refresh: () => Promise<void>
} {
  const key = keyOf(cwd)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(() => entries.get(key)?.catalog ?? null)
  const [loading, setLoading] = useState<boolean>(() => !entries.get(key)?.catalog)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    setCatalog(entries.get(key)?.catalog ?? null)
    const onUpdate = (k: string) => {
      if (k === key && !cancelled) setCatalog(entries.get(key)?.catalog ?? null)
    }
    listeners.add(onUpdate)
    if (entries.get(key)?.catalog) {
      setLoading(false)
    } else {
      setLoading(true)
      void load(cwd, false).then((result) => {
        if (cancelled) return
        setCatalog(result)
        setLoading(false)
      })
    }
    return () => {
      cancelled = true
      listeners.delete(onUpdate)
    }
  }, [key])

  const refresh = useCallback(async () => {
    if (mounted.current) setLoading(true)
    const result = await load(cwd, true)
    // Only an explicit refresh surfaces a failure; background mounts stay silent.
    if (!result) useToast.getState().show('error', 'Could not refresh the model catalog')
    if (!mounted.current) return
    setCatalog(entries.get(key)?.catalog ?? null)
    setLoading(false)
  }, [key])

  return { catalog, loading, degraded: !loading && (catalog === null || catalog.degraded), refresh }
}

/** Test-only: drop the module-scope cache. */
export function __resetModelCatalogForTests(): void {
  entries.clear()
}
