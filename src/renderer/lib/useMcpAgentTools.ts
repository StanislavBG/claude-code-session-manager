/**
 * Data for the Dashboard's HomeAgentTools section: the session-manager-scheduler
 * MCP tool catalog (src/main/lib/mcpToolCatalog.cjs, read in-process over IPC
 * — never a direct HTTP call to GET /admin/mcp/catalog from the renderer).
 *
 * The catalog is static (no cwd dependency), so this hook takes no cwd and makes
 * exactly one IPC call. Per-project delegation readiness is NOT fetched here —
 * NewEpicCard's readiness banner owns it. Failures are reported through
 * `error`, never a toast: the Dashboard is a passive machine-wide surface.
 */
import { useEffect, useState } from 'react'
import type { McpToolCatalogEntry } from '../../preload/api'

export interface McpCatalogState {
  tools: McpToolCatalogEntry[]
  loaded: boolean
  error: string | null
}

const UNAVAILABLE = 'The MCP tool catalog is unavailable.'

export function useMcpCatalog(): McpCatalogState {
  const [state, setState] = useState<McpCatalogState>({ tools: [], loaded: false, error: null })

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => window.api.mcp.catalog())
      .then((catalog) => {
        if (cancelled) return
        if (!catalog?.ok || !catalog.tools?.length) {
          setState({ tools: [], loaded: true, error: UNAVAILABLE })
        } else {
          setState({ tools: catalog.tools, loaded: true, error: null })
        }
      })
      .catch(() => {
        if (cancelled) return
        setState({ tools: [], loaded: true, error: UNAVAILABLE })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
