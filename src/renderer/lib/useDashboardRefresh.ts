import { useCallback, useEffect, useRef, useState } from 'react'
import { refreshKnownProjects } from './useKnownProjects'
import { refreshScheduleState } from '../state/scheduleState'
import { refreshBilling, useBilling } from '../state/billing'
import { usePromptSessions } from '../state/promptSessions'
import { toast } from '../state/toast'

/**
 * The Dashboard panel stays mounted for the app's life (dockview
 * `renderer: 'always'`), so its mount-time loads never re-run. This hook
 * re-reads every Dashboard source on a visit (panel focus, or window
 * focus / tab visible while focused) at most once per
 * DASHBOARD_VISIT_MIN_GAP_MS, and on every explicit `refresh()`.
 */
export const DASHBOARD_VISIT_MIN_GAP_MS = 30_000

export interface DashboardRefreshOptions {
  focused: boolean
  cwds: readonly string[]
  extra?: () => unknown
}

export interface DashboardRefreshResult {
  refresh: () => void
  refreshing: boolean
  lastRefreshedAt: number | null
  failedSources: string[]
}

/** Source names in call order — `failedSources` is reported in this order. */
const SOURCE_ORDER = ['projects', 'sessions', 'queue', 'usage', 'outside items'] as const

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function useDashboardRefresh(opts: DashboardRefreshOptions): DashboardRefreshResult {
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null)
  const [failedSources, setFailedSources] = useState<string[]>([])

  const inFlightRef = useRef(false)
  const lastFinishedAtRef = useRef(0)
  const lastFailedRef = useRef(false)
  const mountedRef = useRef(true)
  const focusedRef = useRef(opts.focused)
  focusedRef.current = opts.focused
  const optsRef = useRef<{ cwds: readonly string[]; extra?: () => unknown }>({ cwds: opts.cwds, extra: opts.extra })
  optsRef.current = { cwds: opts.cwds, extra: opts.extra }
  const hydratedRef = useRef<Set<string>>(new Set())

  const run = useCallback(async (force: boolean): Promise<void> => {
    if (inFlightRef.current) return
    if (!force && Date.now() - lastFinishedAtRef.current < DASHBOARD_VISIT_MIN_GAP_MS) return
    inFlightRef.current = true
    if (mountedRef.current) setRefreshing(true)

    const failed: string[] = []
    let firstMessage: string | null = null
    const guard = async (name: string, fn: () => unknown): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        if (!failed.includes(name)) failed.push(name)
        if (firstMessage === null) firstMessage = messageOf(err)
      }
    }

    const { cwds, extra } = optsRef.current
    for (const cwd of cwds) hydratedRef.current.add(cwd)
    const jobs: Promise<void>[] = [
      guard('projects', () => refreshKnownProjects({ force })),
    ]
    for (const cwd of cwds) {
      jobs.push(guard('sessions', () => usePromptSessions.getState().hydrate(cwd)))
      jobs.push(guard('sessions', () => usePromptSessions.getState().hydrateArchived(cwd)))
    }
    jobs.push(guard('queue', () => refreshScheduleState()))
    if (useBilling.getState().data !== null) jobs.push(guard('usage', () => refreshBilling()))
    if (extra) jobs.push(guard('outside items', () => extra()))
    await Promise.all(jobs)
    failed.sort((a, b) => SOURCE_ORDER.indexOf(a as typeof SOURCE_ORDER[number]) - SOURCE_ORDER.indexOf(b as typeof SOURCE_ORDER[number]))

    lastFinishedAtRef.current = Date.now()
    const previousFailed = lastFailedRef.current
    if (failed.length === 0) {
      lastFailedRef.current = false
      if (mountedRef.current) {
        setLastRefreshedAt(lastFinishedAtRef.current)
        setFailedSources([])
      }
    } else {
      lastFailedRef.current = true
      if (mountedRef.current) {
        setFailedSources(failed)
        if (force || !previousFailed) {
          toast.error(`Dashboard refresh failed (${failed.join(', ')}): ${firstMessage ?? 'unknown error'}`)
        }
      }
    }
    inFlightRef.current = false
    if (mountedRef.current) setRefreshing(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // A visit: mount while focused, or focused going false -> true.
  useEffect(() => {
    if (opts.focused) void run(false)
  }, [opts.focused, run])

  // Hydrate any cwd this instance has not hydrated yet, without waiting for a visit.
  const cwdsKey = opts.cwds.join('\n')
  useEffect(() => {
    const store = usePromptSessions.getState()
    for (const cwd of optsRef.current.cwds) {
      if (hydratedRef.current.has(cwd)) continue
      hydratedRef.current.add(cwd)
      void Promise.resolve().then(() => store.hydrate(cwd)).catch(() => {})
      void Promise.resolve().then(() => store.hydrateArchived(cwd)).catch(() => {})
    }
  }, [cwdsKey])

  // A visit while focused: the window regains focus or the tab becomes visible.
  useEffect(() => {
    const onFocus = () => { if (focusedRef.current) void run(false) }
    const onVisible = () => {
      if (focusedRef.current && document.visibilityState === 'visible') void run(false)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [run])

  const refresh = useCallback(() => { void run(true) }, [run])

  return { refresh, refreshing, lastRefreshedAt, failedSources }
}
