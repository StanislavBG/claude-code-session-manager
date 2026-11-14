import { useEffect, useState } from 'react'
import { useScheduleState } from '../state/scheduleState'
import type { PrdListItem, ScheduleJob } from '../../preload/api'

const EMPTY_JOBS: ScheduleJob[] = []
const EMPTY_PRDS: PrdListItem[] = []

/** Trailing coalesce window for bursts of snapshot changes (AC: <= 500 ms). */
export const LIST_PRDS_COALESCE_MS = 250

/** Map key for the machine-wide (no-cwd, Home-face) list. */
const ALL_KEY = '\u0000all'

interface Entry {
  /** Callers waiting on the next (not yet fired) fetch for this cwd. */
  waiters: Array<{ resolve: (l: PrdListItem[]) => void; reject: (e: unknown) => void }>
  timer: ReturnType<typeof setTimeout> | null
  /** The one IPC call currently in flight for this cwd, if any. */
  inflight: Promise<PrdListItem[]> | null
  last: PrdListItem[] | null
}

const entries = new Map<string, Entry>()

function entryFor(key: string): Entry {
  let e = entries.get(key)
  if (!e) {
    e = { waiters: [], timer: null, inflight: null, last: null }
    entries.set(key, e)
  }
  return e
}

function fire(key: string, cwd: string | undefined): void {
  const e = entryFor(key)
  e.timer = null
  const waiters = e.waiters
  e.waiters = []
  // At most one IPC call in flight per cwd: a window that closes while the
  // previous call is still running chains behind it rather than racing it.
  const prev = e.inflight ?? Promise.resolve()
  const run: Promise<PrdListItem[]> = prev
    .catch(() => undefined)
    .then(() => window.api.schedule.listPrds(cwd))
  e.inflight = run
  run.then(
    (list) => {
      e.last = list
      for (const w of waiters) w.resolve(list)
    },
    (err) => {
      for (const w of waiters) w.reject(err)
    },
  ).finally(() => {
    if (e.inflight === run) e.inflight = null
  })
}

/**
 * Request the PRD list for `cwd` (undefined = machine-wide). Every request
 * landing inside one coalesce window — N mounted hooks reacting to the same
 * snapshot, or a burst of snapshots — shares a single `listPrds` IPC call.
 * The window is fixed from its first request (not reset per request) so a
 * steady stream of snapshots can't starve the fetch.
 */
export function requestScheduledPrds(cwd?: string): Promise<PrdListItem[]> {
  const key = cwd || ALL_KEY
  const e = entryFor(key)
  const p = new Promise<PrdListItem[]>((resolve, reject) => {
    e.waiters.push({ resolve, reject })
  })
  if (!e.timer) e.timer = setTimeout(() => fire(key, cwd || undefined), LIST_PRDS_COALESCE_MS)
  return p
}

export function __resetScheduledPrdsForTests(): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer)
  entries.clear()
}

/**
 * Shared `window.api.schedule.listPrds(cwd)` fetch, re-run whenever a schedule
 * snapshot broadcast changes the job list — single source of truth used by
 * EpicsWorkspace, EpicDetail and SchedulePanel. All mounted instances for the
 * same cwd share one coalesced, single-flight IPC call (the main-process list
 * scan pins every PRD body in memory; one fetch per hook per snapshot fed the
 * main heap OOM loop). Pass the project cwd where one exists; omit it on the
 * Home face for the machine-wide list.
 */
export function useScheduledPrds(cwd?: string | null): PrdListItem[] {
  const scheduleJobs = useScheduleState((s) => s.snapshot?.jobs) ?? EMPTY_JOBS
  const key = cwd || undefined
  const [prds, setPrds] = useState<PrdListItem[]>(
    () => entries.get(key ?? ALL_KEY)?.last ?? EMPTY_PRDS,
  )

  useEffect(() => {
    let alive = true
    requestScheduledPrds(key)
      .then((list) => {
        if (alive) setPrds(list)
      })
      .catch(() => {
        if (alive) setPrds(EMPTY_PRDS)
      })
    return () => {
      alive = false
    }
  }, [scheduleJobs, key])

  return prds
}
