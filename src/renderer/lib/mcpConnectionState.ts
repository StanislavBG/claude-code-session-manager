import type { McpServerStatus, McpStatusResult } from '../../preload/api'
import type { BadgeTone } from '../components/ui/Badge'
import type { StatusDotState } from '../components/ui/StatusDot'

/**
 * Single source of truth for mapping (config presence + live probe result)
 * to one of three at-a-glance UI states. Consumed by both the server list
 * row and the detail pane so they never drift.
 */
export type McpConnectionState = 'ready' | 'not-ready' | 'unprobed'

export interface McpConnectionInfo {
  state: McpConnectionState
  /** Short label for the badge, e.g. "Ready", "Failed", "Not checked". */
  label: string
  /** Raw probe status, if one was found for this server name. */
  probeStatus: McpServerStatus['status'] | null
  badgeTone: BadgeTone
  dotState: StatusDotState
}

const NOT_READY_LABEL: Record<Exclude<McpServerStatus['status'], 'connected' | 'unknown'>, string> = {
  failed: 'Failed',
  'needs-auth': 'Needs auth',
  pending: 'Pending approval',
}

/**
 * `probe` is the full mcp:status() result (or null if never fetched / errored).
 * `name` is the config server name to match against `probe.servers[].name`.
 */
export function deriveMcpConnectionState(
  name: string,
  probe: McpStatusResult | null
): McpConnectionInfo {
  const entry = probe?.ok ? probe.servers.find((s) => s.name === name) : undefined

  if (!entry || entry.status === 'unknown') {
    return {
      state: 'unprobed',
      label: 'Not checked',
      probeStatus: entry?.status ?? null,
      badgeTone: 'dim',
      dotState: 'offline',
    }
  }
  if (entry.status === 'connected') {
    return { state: 'ready', label: 'Ready', probeStatus: entry.status, badgeTone: 'good', dotState: 'live' }
  }
  return {
    state: 'not-ready',
    label: NOT_READY_LABEL[entry.status],
    probeStatus: entry.status,
    badgeTone: 'warn',
    dotState: 'attention',
  }
}
