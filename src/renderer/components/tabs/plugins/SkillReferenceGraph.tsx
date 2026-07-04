import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type { PluginSkillEntry, SkillEdge } from '../../../lib/pluginSkills'

const ACCENT = '#b85c34'
const DIM = '#8a7a60'

export function SkillReferenceGraph({
  skills,
  edges,
  selectedId,
  onSelect,
}: {
  skills: PluginSkillEntry[]
  edges: SkillEdge[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 640, height: 420 })

  useEffect(() => {
    const measure = () => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height })
      }
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const graphData = useMemo(
    () => ({
      nodes: skills.map((s) => ({ id: s.id, name: s.name ?? s.id })),
      links: edges.map((e) => ({ source: e.from, target: e.to })),
    }),
    [skills, edges],
  )

  return (
    <div ref={containerRef} className="w-full h-full">
      <ForceGraph2D
        graphData={graphData}
        width={size.width}
        height={size.height}
        nodeId="id"
        nodeLabel="name"
        nodeColor={(node: any) => (node.id === selectedId ? ACCENT : DIM)}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        onNodeClick={(node: any) => onSelect(node.id)}
      />
    </div>
  )
}
