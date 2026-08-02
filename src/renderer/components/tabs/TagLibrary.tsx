import { useState } from 'react'
import { Panel } from '../ui/Panel'
import { ListDetail } from '../ui/ListDetail'
import { EmptyState } from '../ui/EmptyState'
import { TAG_LIBRARY, type TagLibraryEntry } from '../../lib/tagLibrary'

/**
 * Tag Library — read-only directory of the Epic intent-tag taxonomy.
 * Follows Skills.tsx's canonical list+detail shape, same as its sibling
 * AgentLibrary.tsx. Reads from lib/tagLibrary.ts (the single source of
 * truth also consumed by ticketDisplay.ts and epicQueueControls.ts) rather
 * than hardcoding the tag list again. Home face only — the taxonomy is
 * machine-wide, not per-project.
 */
export function TagLibrary() {
  const [selectedTag, setSelectedTag] = useState<TagLibraryEntry['tag']>(TAG_LIBRARY[0].tag)
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
            {TAG_LIBRARY.map((entry) => (
              <button
                key={entry.tag}
                onClick={() => setSelectedTag(entry.tag)}
                className={`w-full text-left px-3 py-1 text-xs flex flex-col gap-0.5 ${
                  selectedTag === entry.tag
                    ? 'bg-bg-hi text-fg'
                    : 'text-fg-dim hover:text-fg hover:bg-bg-hi'
                }`}
              >
                <span className="truncate">{entry.label}</span>
              </button>
            ))}
          </div>
        }
        detail={selected ? <TagLibraryDetail entry={selected} /> : <EmptyState title="select a tag" />}
      />
    </Panel>
  )
}

function TagLibraryDetail({ entry }: { entry: TagLibraryEntry }) {
  return (
    <div className="p-4 space-y-4 max-w-3xl">
      <div>
        <div className="text-sm font-semibold text-fg">{entry.label}</div>
        <div className="text-xs text-fg-dim mt-1">{entry.description}</div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-fg-faint mb-1">/develop eagerness</div>
        <span className="px-1.5 py-0.5 text-[10px] rounded border border-line text-fg-dim font-mono">
          {entry.developEagerness}
        </span>
      </div>
    </div>
  )
}
