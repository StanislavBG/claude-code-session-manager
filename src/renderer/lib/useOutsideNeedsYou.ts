/**
 * useOutsideNeedsYou — the open "Needs you" items outside apps posted
 * (`window.api.needsYou`), live against its onChanged. Component state only —
 * no zustand store. Feed `items` to buildNeedsYouRows' `outside` argument.
 */
import { useCallback, useEffect, useState } from 'react'
import type { NeedsYouItem } from '../../preload/api'
import { toast } from '../state/toast'

const EMPTY: NeedsYouItem[] = []

type AnswerResult = { ok: true; item: NeedsYouItem } | { ok: false; error: string }

export function useOutsideNeedsYou(): {
  items: NeedsYouItem[]
  answer: (app: string, id: string, value: string) => Promise<AnswerResult>
} {
  const [items, setItems] = useState<NeedsYouItem[]>(EMPTY)
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
    load()
    const off = window.api?.needsYou?.onChanged?.(load)
    return () => {
      cancelled = true
      if (typeof off === 'function') off()
    }
  }, [])
  const answer = useCallback(
    (app: string, id: string, value: string) => window.api.needsYou.answer({ app, id, answer: value }),
    [],
  )
  return { items, answer }
}
