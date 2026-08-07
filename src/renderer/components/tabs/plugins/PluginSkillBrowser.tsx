import { Suspense, lazy, useMemo, useState } from 'react'
import { ListDetail } from '../../ui/ListDetail'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { EmptyState } from '../../ui/EmptyState'
import { detectSkillEdges, type PluginSkillEntry } from '../../../lib/pluginSkills'

// Lazy-loaded so react-force-graph-2d (and its d3-force dependency) is not
// bundled for users who never switch a plugin's skill browser into graph
// view. The Plugins screen is already wrapped in an ErrorBoundary by
// Workbench.tsx's screenNode, so a chunk-load failure surfaces as a pane
// error, not a blank app.
const SkillReferenceGraph = lazy(() =>
  import('./SkillReferenceGraph').then((m) => ({ default: m.SkillReferenceGraph }))
)

/**
 * Full-page skill drill-in, one level deeper than PluginHomePage: header row
 * (back to the plugin + skill name), thin meta strip, and a full-height
 * list/graph body. Mirrors PluginHomePage's own header/meta/body shape so it
 * reads as a sibling page, not a different design system.
 */
export function SkillHomePage({
  pluginName,
  skills,
  onBack,
  initialSelectedId,
}: {
  pluginName: string
  skills: PluginSkillEntry[]
  onBack: () => void
  initialSelectedId?: string
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? skills[0]?.id ?? null)
  const selected = selectedId ? skills.find((s) => s.id === selectedId) ?? null : null
  const edges = useMemo(() => detectSkillEdges(skills), [skills])
  const [view, setView] = useState<'list' | 'graph'>('list')

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Header: back-to-plugin link + skill name + list/graph toggle. */}
      <div className="shrink-0 h-11 flex items-baseline gap-3.5 px-3 border-b border-line bg-bg">
        <button type="button" onClick={onBack} className="font-mono text-accent hover:underline shrink-0 text-xs">
          ← {pluginName}
        </button>
        <span className="font-serif text-[22px] text-fg shrink-0 truncate max-w-[16rem]">
          {selected?.name ?? selected?.id ?? 'skill'}
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex rounded border border-line overflow-hidden">
            <button
              onClick={() => setView('list')}
              className={`px-2 py-0.5 text-xs ${view === 'list' ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi'}`}
            >
              list
            </button>
            <button
              onClick={() => setView('graph')}
              className={`px-2 py-0.5 text-xs ${view === 'graph' ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi'}`}
            >
              graph
            </button>
          </div>
        </div>
      </div>

      {/* Meta strip: selected skill's description + plugin-wide skill/reference counts. */}
      <div className="shrink-0 h-[26px] flex items-center gap-[18px] px-3 bg-bg-elev border-b border-line text-[9px] font-mono uppercase tracking-wide overflow-hidden">
        {selected?.description ? (
          <span className="text-fg-dim truncate normal-case">{selected.description}</span>
        ) : null}
        <span className="ml-auto text-fg-faint truncate normal-case">
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'} · {edges.length}{' '}
          {edges.length === 1 ? 'reference' : 'references'}
        </span>
      </div>

      {/* Body: full-height list+detail, or the reference graph. */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {skills.length === 0 ? (
          <EmptyState title="no skills in this plugin" />
        ) : view === 'graph' ? (
          <Suspense fallback={<div className="p-6 text-xs text-fg-faint">Loading graph…</div>}>
            <SkillReferenceGraph skills={skills} edges={edges} selectedId={selectedId} onSelect={setSelectedId} />
          </Suspense>
        ) : (
          <ListDetail
            sidebar={
              <div className="py-1">
                {skills.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`w-full px-3 py-1 text-xs text-left ${
                      selectedId === s.id ? 'bg-bg-hi text-fg' : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                    }`}
                  >
                    <div className="truncate">{s.name ?? s.id}</div>
                    {s.description ? <div className="truncate text-fg-faint">{s.description}</div> : null}
                  </button>
                ))}
              </div>
            }
            detail={
              selected ? (
                <div className="h-full min-h-0">
                  <MarkdownEditor path={selected.path} value={selected.body} onChange={() => {}} readOnly />
                </div>
              ) : (
                <EmptyState title="select a skill" />
              )
            }
          />
        )}
      </div>
    </div>
  )
}
