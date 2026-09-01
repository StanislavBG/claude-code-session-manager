/**
 * Data for Project Home's PhAgentTools block: the session-manager-scheduler
 * MCP tool catalog (src/main/lib/mcpToolCatalog.cjs, read in-process over IPC
 * — never a direct HTTP call to GET /admin/mcp/catalog from the renderer)
 * plus this project's delegation-readiness checks (reusing the same
 * `app:delegation-readiness` IPC NewEpicCard already calls — no re-probe).
 *
 * The catalog is static (no cwd dependency); readiness is per-project. Both
 * are fetched together, keyed off `cwd`, so a project switch clears the prior
 * project's readiness rather than showing a stale reading against the wrong
 * project (same rule useProjectPagesOutput.ts already follows).
 */
import { useEffect, useState } from 'react'
import { toast } from '../state/toast'
import type { McpToolCatalogEntry, McpRecipe, DelegationReadinessCheck } from '../../preload/api'

export interface McpAgentToolsState {
  tools: McpToolCatalogEntry[]
  recipes: McpRecipe[]
  checks: DelegationReadinessCheck[]
  loaded: boolean
  error: string | null
}

export function useMcpAgentTools(cwd: string | null): McpAgentToolsState {
  const [tools, setTools] = useState<McpToolCatalogEntry[]>([])
  const [recipes, setRecipes] = useState<McpRecipe[]>([])
  const [checks, setChecks] = useState<DelegationReadinessCheck[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    setLoaded(false)
    setError(null)
    Promise.all([window.api.mcp.catalog(), window.api.app.delegationReadiness(cwd)])
      .then(([catalog, readiness]) => {
        if (cancelled) return
        if (!catalog?.ok || !catalog.tools?.length) {
          setError('The MCP tool catalog is unavailable.')
          toast.error('Could not load the MCP tool catalog.')
          setTools([])
          setRecipes([])
        } else {
          setTools(catalog.tools)
          setRecipes(catalog.recipes ?? [])
        }
        setChecks(readiness?.checks ?? [])
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError('The MCP tool catalog is unavailable.')
        toast.error(`Could not load the MCP tool catalog: ${message}`)
        setTools([])
        setRecipes([])
        setChecks([])
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return { tools, recipes, checks, loaded, error }
}
