import { memo, useMemo } from 'react'
import { formatAgo } from '../../../../lib/formatTime'
import type { ClusterInfo, MemoryRow } from './model'

interface Props {
  clusters: ClusterInfo[]
  rows: MemoryRow[]
  generatedAt: number | null
  running: boolean
  unclusteredCount: number
  available: boolean
  onRegenerate: () => void
  onOpenCluster: (id: string) => void
  onOpen: (name: string) => void
}

const BTN = 'text-xs font-medium h-[26px] px-2.5 border border-rule-structural rounded-[5px] bg-bg text-fg hover:border-fg disabled:opacity-50 disabled:cursor-default'
const NOTE = 'text-[11px] text-fg-faint'

export const ClustersView = memo(function ClustersView({
  clusters, rows, generatedAt, running, unclusteredCount, available,
  onRegenerate, onOpenCluster, onOpen,
}: Props) {
  const bySlug = useMemo(() => new Map(rows.map((r) => [r.slug, r])), [rows])

  if (!available) {
    return (
      <div data-testid="mx-clusters" className="flex-1 p-6 text-[13px] text-fg-dim">
        Clusters are available for workspace memory.
      </div>
    )
  }

  if (generatedAt === null && clusters.length === 0) {
    return (
      <div data-testid="mx-clusters" className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="font-serif text-[20px] text-fg">No clusters yet</div>
        <button
          type="button"
          data-testid="mx-clusters-regenerate"
          className={BTN}
          disabled={running}
          onClick={onRegenerate}
        >
          {running ? 'Generating…' : 'Generate'}
        </button>
        <span className={NOTE}>uses Claude · up to 3 min</span>
      </div>
    )
  }

  return (
    <div data-testid="mx-clusters" className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="px-6 py-4 border-b border-rule-structural flex items-center gap-2.5">
        <span className="font-serif text-[20px] text-fg">Clusters</span>
        <span className="text-xs text-fg-dim">
          Generated {formatAgo(generatedAt, Date.now())} from shared references and links
        </span>
        <span className="flex-1" />
        {unclusteredCount > 0 && (
          <span className="text-xs text-honey-dark px-2 py-0.5 rounded bg-butter/40">
            {unclusteredCount} unclustered
          </span>
        )}
        <button
          type="button"
          data-testid="mx-clusters-regenerate"
          className={BTN}
          disabled={running}
          onClick={onRegenerate}
        >
          {running ? 'Generating…' : 'Regenerate'}
        </button>
        <span className={NOTE}>uses Claude</span>
      </div>
      <div className="flex-1 overflow-auto px-6 py-[18px] grid grid-cols-2 gap-4 content-start">
        {clusters.map((c) => (
          <div
            key={c.id}
            data-testid={`mx-cluster-${c.id}`}
            className="bg-bg-hi border border-rule-structural rounded-lg p-4 flex flex-col gap-2.5"
          >
            <div className="flex items-center gap-2">
              <span className={`w-[9px] h-[9px] rounded-[2px] shrink-0 ${c.dotClass}`} />
              <span className="font-serif text-[17px] text-fg min-w-0 flex-1">{c.name}</span>
              <button
                type="button"
                data-testid={`mx-cluster-open-${c.id}`}
                className="text-xs text-accent hover:text-fg"
                onClick={() => onOpenCluster(c.id)}
              >
                Open {c.memberSlugs.length} →
              </button>
            </div>
            <span className="text-[12.5px] leading-normal text-fg-dim">{c.summary}</span>
            <div className="flex flex-wrap gap-[5px] items-center">
              {c.memberSlugs.map((s) => {
                const r = bySlug.get(s)
                return (
                  <button
                    key={s}
                    type="button"
                    className={`font-mono text-[11px] px-[7px] py-[3px] rounded border border-rule-inner text-fg hover:border-fg ${r?.stale ? 'bg-butter/40' : 'bg-bg'}`}
                    onClick={() => onOpen(r?.name ?? `${s}.md`)}
                  >
                    {s}
                  </button>
                )
              })}
            </div>
            <div className="flex gap-3.5 text-[11.5px] text-fg-dim border-t border-rule-inner pt-[9px]">
              <span>{c.linkCount} links</span>
              <span>{c.retireCount} retires</span>
              <span className="text-honey-dark">{c.staleCount} stale</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
})
