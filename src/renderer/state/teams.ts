/**
 * Singleton teams roster poller.
 *
 * Before: AppStatusBar and TeamsCard each ran their own 30s timer hitting
 * `teams:list`. Same data, two requests, two divergent error policies (status
 * bar swallowed silently; TeamsCard toasted on first failure). Unified here.
 *
 * Single source of truth for `teams: TeamInfo[]` across the app.
 */
import { create } from 'zustand'
import type { TeamInfo } from '../../preload/api'
import { toast } from './toast'
import { withTimeout } from '../lib/withTimeout'
import { scheduleTimeoutGraceToast, type GraceWindowHandle } from '../lib/timeoutGraceToast'

const TEAMS_REFRESH_MS = 30_000
const TEAMS_IPC_TIMEOUT_MS = 5_000

interface TeamsState {
  teams: TeamInfo[]
  loaded: boolean
}

export const useTeams = create<TeamsState>(() => ({ teams: [], loaded: false }))

let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let toastedFailure = false
let pendingGraceHandle: GraceWindowHandle | null = null

function fetchTeams(): Promise<{ teams: TeamInfo[] }> {
  return withTimeout(window.api.teams.list(), TEAMS_IPC_TIMEOUT_MS, 'teams.list')
}

async function tick(): Promise<void> {
  try {
    const r = await fetchTeams()
    if (pendingGraceHandle) {
      pendingGraceHandle.cancel()
      pendingGraceHandle = null
    }
    useTeams.setState({ teams: r.teams, loaded: true })
  } catch (e) {
    const handle = scheduleTimeoutGraceToast({
      error: e,
      retry: fetchTeams,
      onRetrySuccess: (r) => {
        pendingGraceHandle = null
        useTeams.setState({ teams: r.teams, loaded: true })
      },
      onStillFailing: (message) => {
        pendingGraceHandle = null
        if (!toastedFailure) {
          toastedFailure = true
          toast.warn(`Teams list fetch: ${message}`)
        }
      },
    })
    if (handle) {
      pendingGraceHandle = handle
    } else if (!toastedFailure) {
      toastedFailure = true
      const msg = e instanceof Error ? e.message : String(e)
      toast.warn(`Teams list fetch failed: ${msg}`)
    }
  }
  timer = setTimeout(tick, TEAMS_REFRESH_MS)
}

/** Call once at app mount. Idempotent. */
export function startTeamsPolling(): void {
  if (started) return
  started = true
  tick()
}

export function refreshTeams(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (pendingGraceHandle) {
    pendingGraceHandle.cancel()
    pendingGraceHandle = null
  }
  tick()
}
