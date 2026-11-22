/**
 * useOutsideNeedsYou — the open "Needs you" items outside apps posted
 * (`window.api.needsYou`), live against its onChanged. Component state only —
 * no zustand store. Feed `items` to buildNeedsYouRows' `outside` argument.
 * `reload` (stable identity) re-runs the same load on demand, e.g. a Refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { NeedsYouItem } from '../../preload/api'
import { toast } from '../state/toast'

const EMPTY: NeedsYouItem[] = []

type AnswerResult = { ok: true; item: NeedsYouItem } | { ok: false; error: string }

export function useOutsideNeedsYou(): {
  items: NeedsYouItem[]
  answer: (app: string, id: string, value: string) => Promise<AnswerResult>
  reload: () => void
} {
  const [items, setItems] = useState<NeedsYouItem[]>(EMPTY)
  const loadRef = useRef<() => void>(() => {})
  useEffect(() => {
    let cancelled = false
    let failing = false
    const load = () => {
      const list = window.api?.needsYou?.list
      if (!list) return
      list()
        .then((r) => {
          failing = false
          if (cancelled) return
          setItems(r.items)
        })
        .catch((err: unknown) => {
          if (failing) return
          failing = true
          toast.error('Could not load outside items: ' + (err instanceof Error ? err.message : String(err)))
        })
    }
    loadRef.current = load
    load()
    const off = window.api?.needsYou?.onChanged?.(load)
    return () => {
      cancelled = true
      loadRef.current = () => {}
      if (typeof off === 'function') off()
    }
  }, [])
  const answer = useCallback(
    (app: string, id: string, value: string) => window.api.needsYou.answer({ app, id, answer: value }),
    [],
  )
  const reload = useCallback(() => loadRef.current(), [])
  return { items, answer, reload }
}
