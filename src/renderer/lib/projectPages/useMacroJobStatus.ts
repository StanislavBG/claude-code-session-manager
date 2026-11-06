/**
 * Background-build state per macro for the active project, from
 * window.api.macros.jobStatus, keyed by macroId. Fetches on mount / cwd
 * change; re-fetches on schedule state pushes (throttled to one per 2000 ms,
 * trailing edge kept so the last push is never lost) and on
 * projectPages.onChanged for the same cwd. Component-local state only.
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from '../../state/toast'
import type { MacroJobStatus } from '../../../preload/api'

const THROTTLE_MS = 2000

export function useMacroJobStatus(cwd: string | null): Record<string, MacroJobStatus> {
  const [statuses, setStatuses] = useState<Record<string, MacroJobStatus>>({})
  const toasted = useRef(false)

  useEffect(() => {
    if (!cwd) {
      setStatuses({})
      return
    }
    let cancelled = false
    let lastFetch = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const load = () => {
      lastFetch = Date.now()
      window.api.macros
        .jobStatus({ cwd })
        .then((rows) => {
          if (cancelled) return
          const next: Record<string, MacroJobStatus> = {}
          for (const r of rows) next[r.macroId] = r
          setStatuses(next)
        })
        .catch((err) => {
          if (cancelled || toasted.current) return
          toasted.current = true
          toast.error(`Could not load build status: ${err instanceof Error ? err.message : String(err)}`)
        })
    }

    const throttled = () => {
      if (timer) return
      const wait = lastFetch + THROTTLE_MS - Date.now()
      if (wait <= 0) {
        load()
        return
      }
      timer = setTimeout(() => {
        timer = null
        load()
      }, wait)
    }

    load()
    const offSchedule = window.api.schedule.onState(throttled)
    const offPages = window.api.projectPages.onChanged((payload) => {
      if (payload.cwd === cwd) load()
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      offSchedule()
      offPages()
    }
  }, [cwd])

  return statuses
}
