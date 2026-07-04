import { useMemo, useState } from 'react'
import { ListDetail } from '../../ui/ListDetail'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { EmptyState } from '../../ui/EmptyState'
import { SkillReferenceGraph } from './SkillReferenceGraph'
import { detectSkillEdges, type PluginSkillEntry } from '../../../lib/pluginSkills'

/** Read-only list+detail browser for an installed plugin's skills — mirrors Skills.tsx's shape. */
export function PluginSkillBrowser({
  skills,
  onClose,
}: {
  skills: PluginSkillEntry[]
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(skills[0]?.id ?? null)
  const selected = selectedId ? skills.find((s) => s.id === selectedId) ?? null : null
  const edges = useMemo(() => detectSkillEdges(skills), [skills])
  const [view, setView] = useState<'list' | 'graph'>('list')

  return (
    <div className="border-t border-line bg-bg-elev h-80 flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line text-xs">
        <span className="text-fg-faint">
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'} · {edges.length}{' '}
          {edges.length === 1 ? 'reference' : 'references'}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-line overflow-hidden">
            <button
              onClick={() => setView('list')}
              className={`px-2 py-0.5 ${view === 'list' ? 'bg-accent text-white' : 'text-fg-faint hover:text-fg'}`}
            >
              list
            </button>
            <button
              onClick={() => setView('graph')}
              className={`px-2 py-0.5 ${view === 'graph' ? 'bg-accent text-white' : 'text-fg-faint hover:text-fg'}`}
            >
              graph
            </button>
          </div>
          <button onClick={onClose} className="text-fg-faint hover:text-fg">×</button>
        </div>
      </div>
      {skills.length === 0 ? (
        <EmptyState title="no skills in this plugin" />
      ) : view === 'graph' ? (
        <div className="flex-1 min-h-0">
          <SkillReferenceGraph
            skills={skills}
            edges={edges}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <ListDetail
            sidebar={
              <div className="py-1">
                {skills.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedId(s.id)}
                    className={`w-full px-3 py-1 text-xs text-left ${
                      selectedId === s.id
                        ? 'bg-bg-hi text-fg'
                        : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                    }`}
                  >
                    <div className="truncate">{s.name ?? s.id}</div>
                    {s.description ? (
                      <div className="truncate text-fg-faint">{s.description}</div>
                    ) : null}
                  </button>
                ))}
              </div>
            }
            detail={
              selected ? (
                <div className="h-full flex flex-col">
                  {selected.description ? (
                    <div className="px-3 py-2 text-xs text-fg-dim border-b border-line shrink-0">
                      {selected.description}
                    </div>
                  ) : null}
                  <div className="flex-1 min-h-0">
                    <MarkdownEditor path={selected.path} value={selected.body} onChange={() => {}} readOnly />
                  </div>
                </div>
              ) : (
                <EmptyState title="select a skill" />
              )
            }
          />
        </div>
      )}
    </div>
  )
}
