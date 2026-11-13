/**
 * The Project Home MD network explorer's curation — the human's verdicts, notes, reviewed
 * stamps and record/doc folder overrides — kept in the project's ui-prefs (`mdCuration`).
 *
 * Read once per cwd through `normalizeCuration`; every change updates the in-memory state at
 * once and persists the whole curation with `writeUiPrefsPatch`. A refused write (a web remote
 * may not write config) toasts and keeps the in-memory state. The loaded state is keyed by cwd,
 * so a project switch never shows another project's curation (`ready` is false until it loads).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readUiPrefs, writeUiPrefsPatch } from './uiPrefs'
import { EMPTY_CURATION, normalizeCuration, type MdCuration, type MdVerdict } from './mdCurate'
import { toast } from '../state/toast'

export type MdFolderKind = 'records' | 'docs'

export interface UseMdCuration {
  curation: MdCuration
  ready: boolean
  setVerdict: (path: string, v: MdVerdict | null) => void
  setNote: (path: string, text: string) => void
  markReviewed: (path: string) => void
  setFolderKind: (folder: string, kind: MdFolderKind | null) => void
  /** Removes every verdict (the curation tray's Clear). */
  clearVerdicts: () => void
}

type Loaded = { cwd: string; curation: MdCuration }

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

export function useMdCuration(cwd: string | null | undefined): UseMdCuration {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // Mutators read the latest state synchronously, so two quick edits never drop one.
  const latest = useRef<Loaded | null>(null)

  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    readUiPrefs(cwd).then(
      (prefs) => {
        if (cancelled) return
        const next = { cwd, curation: normalizeCuration(prefs.mdCuration) }
        latest.current = next
        setLoaded(next)
      },
      () => {
        if (cancelled) return
        const next = { cwd, curation: normalizeCuration(undefined) }
        latest.current = next
        setLoaded(next)
      },
    )
    return () => {
      cancelled = true
    }
  }, [cwd])

  const ready = !!cwd && loaded?.cwd === cwd

  const update = useCallback(
    (change: (c: MdCuration) => MdCuration) => {
      const cur = latest.current
      if (!cwd || !cur || cur.cwd !== cwd) return
      const curation = change(cur.curation)
      if (curation === cur.curation) return
      const next = { cwd, curation }
      latest.current = next
      setLoaded(next)
      writeUiPrefsPatch(cwd, { mdCuration: curation }).catch((err: unknown) => {
        const message = (err instanceof Error ? err.message : String(err)) || 'Unknown error'
        toast.error(`Could not save doc curation: ${message}`)
      })
    },
    [cwd],
  )

  const setVerdict = useCallback(
    (path: string, v: MdVerdict | null) =>
      update((c) => {
        if (v === null) {
          const verdicts = without(c.verdicts, path)
          return verdicts === c.verdicts ? c : { ...c, verdicts }
        }
        return c.verdicts[path] === v ? c : { ...c, verdicts: { ...c.verdicts, [path]: v } }
      }),
    [update],
  )

  const setNote = useCallback(
    (path: string, text: string) =>
      update((c) => {
        if (!text.trim()) {
          const notes = without(c.notes, path)
          return notes === c.notes ? c : { ...c, notes }
        }
        return c.notes[path] === text ? c : { ...c, notes: { ...c.notes, [path]: text } }
      }),
    [update],
  )

  const markReviewed = useCallback(
    (path: string) => update((c) => ({ ...c, reviewedAt: { ...c.reviewedAt, [path]: Date.now() } })),
    [update],
  )

  const setFolderKind = useCallback(
    (folder: string, kind: MdFolderKind | null) =>
      update((c) => {
        const recordFolders = c.recordFolders.filter((f) => f !== folder)
        const docFolders = c.docFolders.filter((f) => f !== folder)
        if (kind === 'records') recordFolders.push(folder)
        if (kind === 'docs') docFolders.push(folder)
        const same = (a: string[], b: string[]) => a.length === b.length && a.every((f, i) => f === b[i])
        return same(recordFolders, c.recordFolders) && same(docFolders, c.docFolders) ? c : { ...c, recordFolders, docFolders }
      }),
    [update],
  )

  const clearVerdicts = useCallback(
    () => update((c) => (Object.keys(c.verdicts).length === 0 ? c : { ...c, verdicts: {} })),
    [update],
  )

  return {
    curation: ready && loaded ? loaded.curation : EMPTY_CURATION,
    ready,
    setVerdict,
    setNote,
    markReviewed,
    setFolderKind,
    clearVerdicts,
  }
}
