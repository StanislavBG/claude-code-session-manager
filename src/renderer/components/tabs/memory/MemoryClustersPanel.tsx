/**
 * MemoryClustersPanel — user-facing replacement for the retired Knowledge
 * Graph. Renders the `memory:aggregate` (PRD 355) result as named semantic
 * cluster cards for the active workspace's memories.
 *
 * Cost discipline: mount calls `aggregate(workspace, false)` (cache-only, no
 * `claude -p` spend). Only the explicit Aggregate/Refresh button passes
 * `refresh: true`. If the IPC throws (e.g. absent at runtime because PRD 355
 * hasn't landed), we fail soft — toast + empty state, never crash the tab.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyState } from '../../ui/EmptyState'
import { formatMtimeMs } from '../../../lib/formatTime'
import { toast } from '../../../state/toast'
import type { MemoryAggregateResult, MemoryCluster } from '../../../../preload/api'

interface Props {
  /** Encoded workspace key for the IPC layer. */
  workspace: string
  /** Open a member memory in the Editor view (parent switches view + selection). */
  onOpenMember: (slug: string) => void
}

export function MemoryClustersPanel({ workspace, onOpenMember }: Props) {
  const [result, setResult] = useState<MemoryAggregateResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // Guards against a slow in-flight request from a prior workspace clobbering
  // a faster one from the current workspace.
  const requestRef = useRef(0)

  const load = useCallback(
    async (refresh: boolean) => {
      const requestId = ++requestRef.current
      setBusy(true)
      try {
        const r = await window.api.memory.aggregate(workspace, refresh)
        if (requestRef.current !== requestId) return
        setResult(r)
      } catch (e) {
        if (requestRef.current !== requestId) return
        toast.error(`Memory aggregate failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (requestRef.current === requestId) {
          setBusy(false)
          setLoaded(true)
        }
      }
    },
    [workspace],
  )

  // Mount / workspace switch — cache-only, no LLM spend.
  useEffect(() => {
    setResult(null)
    setLoaded(false)
    load(false)
  }, [load])

  const clusters = result?.clusters ?? []
  const orphans = result?.orphans ?? []
  const hasAny = clusters.length > 0 || orphans.length > 0

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line text-xs">
        <span className="text-fg-faint">
          {result?.generatedAt ? `generated ${formatMtimeMs(result.generatedAt)} ago` : 'not yet aggregated'}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => load(true)}
          disabled={busy}
          className="px-2 py-0.5 text-xs text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? 'Aggregating…' : result?.generatedAt ? 'Refresh' : 'Aggregate'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {!loaded ? (
          <EmptyState title="loading…" />
        ) : !hasAny ? (
          <EmptyState
            title="no clusters yet"
            hint="Click Aggregate to organize this workspace's memories into named clusters."
          />
        ) : (
          <div className="space-y-4">
            {clusters.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {clusters.map((c) => (
                  <ClusterCard key={c.id} cluster={c} onOpenMember={onOpenMember} />
                ))}
              </div>
            )}
            {orphans.length > 0 && (
              <div className="border border-line rounded p-3">
                <div className="text-xs text-fg mb-2">Unclustered</div>
                <div className="flex flex-wrap gap-1">
                  {orphans.map((slug) => (
                    <button
                      key={slug}
                      onClick={() => onOpenMember(slug)}
                      className="px-2 py-0.5 text-[11px] font-mono text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
                    >
                      {slug}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ClusterCard({
  cluster,
  onOpenMember,
}: {
  cluster: MemoryCluster
  onOpenMember: (slug: string) => void
}) {
  return (
    <div className="border border-line rounded p-3">
      <div className="text-sm text-fg">{cluster.name}</div>
      {cluster.summary && <div className="text-xs text-fg-faint mt-0.5">{cluster.summary}</div>}
      <div className="mt-2 flex flex-wrap gap-1">
        {cluster.memberSlugs.map((slug) => (
          <button
            key={slug}
            onClick={() => onOpenMember(slug)}
            className="px-2 py-0.5 text-[11px] font-mono text-fg-dim hover:text-fg border border-line hover:border-fg-faint rounded transition-colors"
          >
            {slug}
          </button>
        ))}
      </div>
      {cluster.links.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {cluster.links.map((l, i) => (
            <div key={`${l.from}-${l.to}-${i}`} className="text-[10px] text-fg-faint font-mono">
              {l.from} → {l.to}
              {l.label ? ` (${l.label})` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
