import { useEffect, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { EmptyState } from '../ui/EmptyState'
import { toast } from '../../state/toast'
import type { AgentPersona } from '../../../preload/api'

/**
 * Agent Library — read-only directory of agent personas. Follows Skills.tsx's
 * canonical list+detail shape: a component-local fetch on mount (no store,
 * since this data isn't hot/live), a filterable sidebar list, and a detail
 * pane for the selected item. Home face only — this is cross-project/machine
 * data, not a per-project view (see navGroups.ts).
 *
 * Global personas come from `~/.claude/agents/*.md`; `overridingProjects`
 * lists which currently-open project tabs have a same-named overlay at
 * `<cwd>/.claude/agents/<name>.md`, which Claude Code's own precedence rules
 * prefer over the global definition.
 */
export function AgentLibrary() {
  const [personas, setPersonas] = useState<AgentPersona[] | null>(null)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await window.api.agents.listPersonas()
        if (cancelled || !mounted.current) return
        setPersonas(list)
        setSelectedName((cur) => cur ?? list[0]?.name ?? null)
      } catch (e) {
        if (cancelled || !mounted.current) return
        setPersonas([])
        toast.error((e as Error).message || 'failed to load agent personas')
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (personas === null) return <EmptyState title="loading…" />

  const needle = filter.toLowerCase()
  const filtered = personas.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || (p.description ?? '').toLowerCase().includes(needle),
  )
  const selected = personas.find((p) => p.name === selectedName) ?? null

  return (
    <Panel
      toolbar={
        <>
          <span className="text-fg-faint">
            {personas.length} persona{personas.length === 1 ? '' : 's'}
          </span>
          <div className="flex-1" />
          {selected && <span className="text-fg-faint truncate">{selected.path}</span>}
        </>
      }
    >
      <ListDetail
        sidebar={
          <div className="py-1">
            <div className="px-2 pb-1">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                className="w-full bg-bg border border-line rounded px-2 py-0.5 text-xs text-fg"
              />
            </div>
            {filtered.length === 0 ? (
              <div className="px-3 py-1 text-xs text-fg-faint italic">no agent personas found</div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.name}
                  onClick={() => setSelectedName(p.name)}
                  className={`w-full text-left px-3 py-1 text-xs flex flex-col gap-0.5 ${
                    selectedName === p.name
                      ? 'bg-bg-hi text-fg'
                      : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                  }`}
                >
                  <span className="flex items-center gap-2 justify-between w-full">
                    <span className="truncate">{p.name}</span>
                    {p.overridingProjects.length > 0 && (
                      <span
                        className="shrink-0 px-1.5 py-0.5 text-[10px] rounded border border-line text-fg-faint"
                        title={`Overridden in: ${p.overridingProjects.join(', ')}`}
                      >
                        {p.overridingProjects.length} override{p.overridingProjects.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  {p.description && (
                    <span className="truncate text-fg-faint">{p.description}</span>
                  )}
                </button>
              ))
            )}
          </div>
        }
        detail={selected ? <AgentPersonaDetail persona={selected} /> : <EmptyState title="select an agent" />}
      />
    </Panel>
  )
}

function AgentPersonaDetail({ persona }: { persona: AgentPersona }) {
  return (
    <div className="p-4 space-y-4 max-w-3xl">
      <div>
        <div className="text-sm font-semibold text-fg">{persona.name}</div>
        {persona.description && <div className="text-xs text-fg-dim mt-1">{persona.description}</div>}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-fg-faint mb-1">Tools</div>
        {persona.tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {persona.tools.map((t) => (
              <span key={t} className="px-1.5 py-0.5 text-[10px] rounded border border-line text-fg-dim font-mono">
                {t}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-fg-faint italic">no tools restriction declared</div>
        )}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-fg-faint mb-1">Overriding projects</div>
        {persona.overridingProjects.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {persona.overridingProjects.map((name) => (
              <span key={name} className="px-1.5 py-0.5 text-[10px] rounded border border-line text-fg-faint">
                {name}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-fg-faint italic">
            no open project overlays this agent — the global definition applies everywhere
          </div>
        )}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-fg-faint mb-1">Definition</div>
        <pre className="text-xs text-fg-dim whitespace-pre-wrap bg-bg-elev border border-line rounded p-3 max-h-[50vh] overflow-auto">
          {persona.body}
        </pre>
      </div>
    </div>
  )
}
