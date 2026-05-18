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

async function tick(): Promise<void> {
  try {
    const r = await withTimeout(window.api.teams.list(), TEAMS_IPC_TIMEOUT_MS, 'teams.list')
    useTeams.setState({ teams: r.teams, loaded: true })
  } catch (e) {
    if (!toastedFailure) {
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
  tick()
}
