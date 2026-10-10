import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type NodeObject } from 'react-force-graph-2d'
import type { PluginSkillEntry, SkillEdge } from '../../../lib/pluginSkills'

// Fallbacks only: the live colours come from the CSS custom properties below.
const ACCENT_FALLBACK = '#b85c34'
const DIM_FALLBACK = '#8a7a60'

function readCssVar(name: string, fallback: string): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  } catch {
    return fallback
  }
}

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
  const accent = useMemo(() => readCssVar('--accent', ACCENT_FALLBACK), [])
  const dim = useMemo(() => readCssVar('--fg-faint', DIM_FALLBACK), [])
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
        nodeColor={(node: NodeObject) => (node.id === selectedId ? accent : dim)}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        onNodeClick={(node: NodeObject) => onSelect(String(node.id))}
      />
    </div>
  )
}
