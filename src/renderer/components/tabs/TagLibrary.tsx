import { useEffect, useRef, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { EmptyState } from '../ui/EmptyState'
import { TAG_LIBRARY, type TagLibraryEntry } from '../../lib/tagLibrary'
import { ticketTagTone } from '../../lib/ticketDisplay'
import { agentTagDef } from '../../lib/agentTagDefs'
import { toast } from '../../state/toast'
import type { AgentPersona } from '../../../preload/api'

/**
 * Tag Library — read-only directory of the Epic intent-tag taxonomy, plus a
 * writable relationship: which agent personas carry a given tag. Follows
 * Skills.tsx's canonical list+detail shape, same as its sibling
 * AgentLibrary.tsx. Reads from lib/tagLibrary.ts (the single source of
 * truth also consumed by ticketDisplay.ts and epicQueueControls.ts) rather
 * than hardcoding the tag list again — colors come from ticketTagTone (the
 * same tone used for the tag chip everywhere else in the app), and the
 * "opening framing" block below quotes agentTagDefs.ts's initialPromptTemplate
 * verbatim, per CLAUDE.md's rule that a tag's mission text has exactly one
 * source. The tag TAXONOMY itself stays read-only: EpicTag is a closed
 * TypeScript union threaded through composeEpicIntake, ticketDisplayStatus,
 * and epicQueueControls's group order — adding/renaming tags at runtime would
 * mean converting that into a dynamic, persisted taxonomy, a materially
 * bigger change than this page's redesign. What IS writable here is the
 * agent↔tag assignment: each persona's `tags:` frontmatter field
 * (agentLibrary.cjs) is the single source of truth, and this page
 * assigns/removes it from the tag side exactly as AgentLibrary.tsx does from
 * the agent side. Home face only — the taxonomy is machine-wide, not
 * per-project.
 */
export function TagLibrary() {
  const [selectedTag, setSelectedTag] = useState<TagLibraryEntry['tag']>(TAG_LIBRARY[0].tag)
  const [personas, setPersonas] = useState<AgentPersona[] | null>(null)
  const [adding, setAdding] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = async () => {
    try {
      const list = await window.api.agents.listPersonas()
      if (mounted.current) setPersonas(list)
    } catch (e) {
      if (!mounted.current) return
      setPersonas([])
      toast.error((e as Error).message || 'failed to load agent personas')
    }
  }

  useEffect(() => { load() }, [])

  const selected = TAG_LIBRARY.find((entry) => entry.tag === selectedTag) ?? null

  const assign = async (persona: AgentPersona, tag: string) => {
    try {
      await window.api.agents.savePersona({
        name: persona.name,
        originalName: persona.name,
        description: persona.description ?? '',
        tools: persona.tools,
        model: persona.model ?? 'inherit',
        color: persona.color ?? '',
        tags: [...persona.tags, tag],
        body: persona.body,
      })
      setAdding(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'failed to assign tag')
    }
  }

  const unassign = async (persona: AgentPersona, tag: string) => {
    try {
      await window.api.agents.savePersona({
        name: persona.name,
        originalName: persona.name,
        description: persona.description ?? '',
        tools: persona.tools,
        model: persona.model ?? 'inherit',
        color: persona.color ?? '',
        tags: persona.tags.filter((t) => t !== tag),
        body: persona.body,
      })
      await load()
    } catch (e) {
      toast.error((e as Error).message || 'failed to remove tag')
    }
  }

  return (
    <Panel
      toolbar={
        <span className="text-fg-faint">
          {TAG_LIBRARY.length} tag{TAG_LIBRARY.length === 1 ? '' : 's'}
        </span>
      }
    >
      <ListDetail
        sidebar={
          <div className="py-1">
            {TAG_LIBRARY.map((entry) => {
              const tone = ticketTagTone(entry.tag)
              const on = selectedTag === entry.tag
              const count = personas?.filter((p) => p.tags.includes(entry.tag)).length ?? 0
              return (
                <button
                  key={entry.tag}
                  onClick={() => { setSelectedTag(entry.tag); setAdding(false) }}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 border-l-2 ${
                    on ? 'bg-bg-hi text-fg border-accent' : 'text-fg-dim hover:text-fg hover:bg-bg-hi border-transparent'
                  }`}
                >
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${tone.bg} ${tone.text} ${tone.border ? 'border border-current/30' : ''}`}>
                    #{entry.tag}
                  </span>
                  <span className="truncate">{entry.label}</span>
                  {count > 0 && <span className="ml-auto text-[10.5px] text-fg-faint font-mono shrink-0">{count}</span>}
                </button>
              )
            })}
          </div>
        }
        detail={
          selected ? (
            <TagLibraryDetail
              entry={selected}
              personas={personas}
              adding={adding}
              setAdding={setAdding}
              onAssign={assign}
              onUnassign={unassign}
            />
          ) : (
            <EmptyState title="select a tag" />
          )
        }
      />
    </Panel>
  )
}

function TagLibraryDetail({
  entry, personas, adding, setAdding, onAssign, onUnassign,
}: {
  entry: TagLibraryEntry
  personas: AgentPersona[] | null
  adding: boolean
  setAdding: (v: boolean) => void
  onAssign: (persona: AgentPersona, tag: string) => void
  onUnassign: (persona: AgentPersona, tag: string) => void
}) {
  const tone = ticketTagTone(entry.tag)
  const def = agentTagDef(entry.tag)
  const assigned = personas?.filter((p) => p.tags.includes(entry.tag)) ?? []
  const unassigned = personas?.filter((p) => !p.tags.includes(entry.tag)) ?? []

  return (
    <div className="p-4 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2.5">
        <span className={`px-2 py-1 rounded text-xs font-mono font-semibold ${tone.bg} ${tone.text} ${tone.border ? 'border border-current/30' : ''}`}>
          #{entry.tag}
        </span>
        <span className="text-sm font-semibold text-fg">{entry.label}</span>
      </div>
      <div className="text-xs text-fg-dim leading-relaxed">{entry.description}</div>
      <div>
        <div className="text-[10.5px] uppercase tracking-wide text-fg-faint mb-1.5 font-mono">/develop eagerness</div>
        <span className="px-1.5 py-0.5 text-[10px] rounded border border-line text-fg-dim font-mono">
          {entry.developEagerness}
        </span>
      </div>
      <div>
        <div className="text-[10.5px] uppercase tracking-wide text-fg-faint mb-1.5 font-mono">agents carrying this tag</div>
        {personas === null ? (
          <div className="text-xs text-fg-faint italic">loading…</div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {assigned.map((p) => (
              <span key={p.name} className="inline-flex items-center gap-1.5 bg-bg-elev border border-line rounded px-2 py-0.5 text-[11px] font-mono text-fg-dim">
                {p.name}
                <button onClick={() => onUnassign(p, entry.tag)} title="Remove this tag from the agent" className="text-fg-faint hover:text-fg">×</button>
              </span>
            ))}
            {assigned.length === 0 && !adding && (
              <span className="text-xs text-fg-faint italic mr-1">no agent carries this tag yet.</span>
            )}
            {adding ? (
              unassigned.length > 0 ? (
                <select
                  autoFocus
                  defaultValue=""
                  onChange={(e) => { const p = personas.find((x) => x.name === e.target.value); if (p) onAssign(p, entry.tag) }}
                  onBlur={() => setAdding(false)}
                  className="bg-bg border border-line rounded px-2 py-0.5 text-[11px] text-fg font-mono"
                >
                  <option value="" disabled>pick an agent…</option>
                  {unassigned.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              ) : (
                <span className="text-xs text-fg-faint italic">every agent already carries this tag.</span>
              )
            ) : (
              <button onClick={() => setAdding(true)} className="px-2 py-0.5 rounded-full text-[11px] font-mono border border-line text-fg-faint hover:text-fg hover:bg-bg-hi">
                + assign agent
              </button>
            )}
          </div>
        )}
      </div>
      <div>
        <div className="text-[10.5px] uppercase tracking-wide text-fg-faint mb-1.5 font-mono">
          opening framing — sent before the human's goal
        </div>
        <pre className="text-xs text-fg-dim whitespace-pre-wrap bg-bg-elev border border-line rounded p-3 leading-relaxed font-sans">
          {def.initialPromptTemplate}
        </pre>
      </div>
    </div>
  )
}
