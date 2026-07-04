import { useMemo, useState } from 'react'
import { ListDetail } from '../../ui/ListDetail'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { EmptyState } from '../../ui/EmptyState'
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
  const edgeCount = useMemo(() => detectSkillEdges(skills).length, [skills])

  return (
    <div className="border-t border-line bg-bg-elev h-80 flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-line text-xs">
        <span className="text-fg-faint">
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'} · {edgeCount}{' '}
          {edgeCount === 1 ? 'reference' : 'references'}
        </span>
        <button onClick={onClose} className="text-fg-faint hover:text-fg">×</button>
      </div>
      {skills.length === 0 ? (
        <EmptyState title="no skills in this plugin" />
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
