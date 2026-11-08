/**
 * mcpChecks.ts — zustand store over window.api.mcp.checkServer.
 *
 * Keeps the last on-demand check of each configured MCP server (status, tools, checkedAt) so
 * the Extensions ▸ MCP list's status dots and "<n> servers · <m> checked" summary, and the
 * detail's "checked <ago>" + tools, survive tab switches. Checks run only when asked for
 * (check / checkAll): no polling, no check on import or mount.
 *
 * Island store: imports no other renderer store (toast is a module-level helper, not a store
 * subscription). Components read through the exported selectors, which return stored
 * references or primitives — never a value built per call (CLAUDE.md Avoid list).
 */

import { create } from 'zustand'
import type { McpCheckRequest, McpCheckResult } from '../../preload/api'
import { toast } from './toast'

/** Most checks checkAll runs at once — every check spawns the server in main. */
export const MCP_CHECK_CONCURRENCY = 2

/** Store key for one configured server: `${source}:${pluginKey ?? cwd ?? ''}:${name}`. */
export function mcpCheckKey(req: McpCheckRequest): string {
  return `${req.source}:${req.pluginKey ?? req.cwd ?? ''}:${req.name}`
}

export interface McpChecksState {
  /** Last finished check per mcpCheckKey; a check that threw is stored as status 'failed'. */
  results: Record<string, McpCheckResult>
  /** true while a check for that key is in flight; the key is removed once it settles. */
  checking: Record<string, boolean>
  /** Check one server; joins the check already in flight for its key. Never rejects. */
  check: (req: McpCheckRequest) => Promise<McpCheckResult>
  /** Check every server in reqs, at most MCP_CHECK_CONCURRENCY at once; resolves when all finish. */
  checkAll: (reqs: McpCheckRequest[]) => Promise<void>
}

// In-flight checks by key, kept outside the store so they don't trigger re-renders. A second
// check for a key already in flight gets this promise instead of spawning the server again.
const inFlight = new Map<string, Promise<McpCheckResult>>()

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One checkServer call; a throw (sync or async) becomes a 'failed' result plus an error toast. */
async function runCheck(req: McpCheckRequest): Promise<McpCheckResult> {
  try {
    return await window.api.mcp.checkServer(req)
  } catch (e) {
    const error = errText(e)
    toast.error(`MCP check of ${req.name} failed: ${error}`)
    return { ok: false, status: 'failed', error, checkedAt: Date.now() }
  }
}

export const useMcpChecks = create<McpChecksState>((set, get) => ({
  results: {},
  checking: {},

  check: (req) => {
    const key = mcpCheckKey(req)
    const running = inFlight.get(key)
    if (running) return running
    set((s) => ({ checking: { ...s.checking, [key]: true } }))
    // runCheck is async, so this callback always runs after inFlight.set below — even when
    // checkServer throws synchronously — and the key can never stay stuck in flight.
    const run = runCheck(req).then((result) => {
      inFlight.delete(key)
      set((s) => {
        const checking = { ...s.checking }
        delete checking[key]
        return { results: { ...s.results, [key]: result }, checking }
      })
      return result
    })
    inFlight.set(key, run)
    return run
  },

  checkAll: async (reqs) => {
    // One entry per key: a list naming the same server twice checks it once.
    const queue = [...new Map(reqs.map((r) => [mcpCheckKey(r), r] as const)).values()]
    let next = 0
    // Each worker takes the next request once its current check settles (check never rejects).
    const worker = async () => {
      while (next < queue.length) await get().check(queue[next++])
    }
    await Promise.all(Array.from({ length: Math.min(MCP_CHECK_CONCURRENCY, queue.length) }, worker))
  },
}))

/* Selectors — each returns a stored reference or a primitive, so a component re-renders only
 * when that slice really changes. Derive counts/lists in the component, outside the selector. */

export const selectMcpCheckResults = (s: McpChecksState): Record<string, McpCheckResult> => s.results

export const selectMcpChecking = (s: McpChecksState): Record<string, boolean> => s.checking

export const selectMcpCheckResult =
  (key: string) =>
  (s: McpChecksState): McpCheckResult | undefined =>
    s.results[key]

export const selectMcpIsChecking =
  (key: string) =>
  (s: McpChecksState): boolean =>
    s.checking[key] === true
