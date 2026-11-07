import { memo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { EmptyState } from '../ui/EmptyState'
import { TAG_LIBRARY, type TagLibraryEntry } from '../../lib/tagLibrary'
import { ticketTagTone } from '../../lib/ticketDisplay'
import { agentTagDef } from '../../lib/agentTagDefs'
import { toast } from '../../state/toast'
import { useAgentPersonasState } from '../../lib/useAgentPersonas'
import { useAgentsDirWatch } from '../../lib/useAgentsDirWatch'
import type { AgentPersona } from '../../../preload/api'


/**
 * Tag Library — read-only directory of the Epic intent-tag taxonomy and which
 * agent personas carry each tag (shown as the Tags tab of AgentLibrary.tsx). Follows
 * Skills.tsx's canonical list+detail shape, same as its sibling
 * AgentLibrary.tsx. Reads from lib/tagLibrary.ts (the single source of
 * truth also consumed by ticketDisplay.ts and epicQueueControls.ts) rather
 * than hardcoding the tag list again — colors come from ticketTagTone (the
 * same tone used for the tag chip everywhere else in the app), and the
 * "opening framing" block below quotes agentTagDefs.ts's initialPromptTemplate
 * verbatim, per CLAUDE.md's rule that a tag's mission text has exactly one
 * source.
 * Assignment is edited only on the persona side (Agent Library → Personas →
 * tags); this view never writes persona files.
 * Home face only — the taxonomy is machine-wide, not
 * per-project.
 */
function TagLibraryComponent({ onOpenPersona }: { onOpenPersona?: (name: string) => void }) {
  const [selectedTag, setSelectedTag] = useState<TagLibraryEntry['tag']>(TAG_LIBRARY[0].tag)
  const { personas, refresh } = useAgentPersonasState((e) => toast.error(e.message || 'failed to load agent personas'))

  // agents:changed only fires as a write-echo from this app's OWN save — an
  // external edit to ~/.claude/agents/*.md is otherwise invisible. This page
  // is Home-face, machine-wide only (see docblock above), so only the global
  // directory is watched — no per-project overlay concept here.
  useAgentsDirWatch(null, () => { void refresh() })

  const selected = TAG_LIBRARY.find((entry) => entry.tag === selectedTag) ?? null

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
                  onClick={() => { setSelectedTag(entry.tag) }}
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
              onOpenPersona={onOpenPersona}
            />
          ) : (
            <EmptyState title="select a tag" />
          )
        }
      />
    </Panel>
  )
}

// Memoized: no props; own data comes from store/IPC hooks inside the component.
export const TagLibrary = memo(TagLibraryComponent)

function TagLibraryDetail({
  entry, personas, onOpenPersona,
}: {
  entry: TagLibraryEntry
  personas: AgentPersona[] | null
  onOpenPersona?: (name: string) => void
}) {
  const tone = ticketTagTone(entry.tag)
  const def = agentTagDef(entry.tag)
  const assigned = personas?.filter((p) => p.tags.includes(entry.tag)) ?? []

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
        <div className="text-[10.5px] uppercase tracking-wide text-fg-faint mb-1.5 font-mono">develops via</div>
        <span className="px-1.5 py-0.5 text-[10px] rounded border border-line text-fg-dim font-mono">
          {entry.developsVia}
        </span>
      </div>
      <div>
        <div className="text-[10.5px] uppercase tracking-wide text-fg-faint mb-1.5 font-mono">agents carrying this tag</div>
        {personas === null ? (
          <div className="text-xs text-fg-faint italic">loading…</div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {assigned.map((p) => (
              <button
                key={p.name}
                onClick={() => onOpenPersona?.(p.name)}
                title={`Open ${p.name} in Personas`}
                className="inline-flex items-center bg-bg-elev border border-line rounded px-2 py-0.5 text-[11px] font-mono text-fg-dim hover:text-fg hover:bg-bg-hi"
              >
                {p.name}
              </button>
            ))}
            {assigned.length === 0 && (
              <span className="text-xs text-fg-faint italic mr-1">no agent carries this tag yet.</span>
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
