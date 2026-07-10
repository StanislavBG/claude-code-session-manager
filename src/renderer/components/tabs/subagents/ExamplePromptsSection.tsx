/**
 * Read-only reference section: the bundled seed prompt library, rendered at
 * the bottom of the Subagents tab. Reuses promptsSeed.ts / promptFrontmatter.ts
 * directly — no re-parsing, no override store, no edit/save/auto-fire actions.
 * First half of retiring the standalone Prompts tab (PRD 394 removes the tab).
 */

import { useState } from 'react'
import { seedPrompts } from '../../../lib/promptsSeed'
import type { Prompt } from '../../../lib/promptFrontmatter'
import { HiveCell, paletteAt } from './hive-primitives'

// Fixed display order for category groups, mirroring the old Prompts tab.
// Categories found in the seed set but missing here are appended after.
const CATEGORY_ORDER: string[] = [
  'Security',
  'QA',
  'Performance',
  'Code Review',
  'Debugging',
  'Refactoring',
  'Documentation',
  'Git / PR',
]

const ALL_CATEGORIES: string[] = [
  ...CATEGORY_ORDER,
  ...[...new Set(seedPrompts.map((p) => p.category))].filter((c) => !CATEGORY_ORDER.includes(c)),
]

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1100)
  }
  return (
    <button
      onClick={onCopy}
      className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-fg-dim hover:bg-hi hover:text-fg transition-colors"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function ExamplePromptCard({ prompt, paletteIndex }: { prompt: Prompt; paletteIndex: number }) {
  const pal = paletteAt(paletteIndex)
  return (
    <div className="rounded-xl border border-line bg-bg p-3.5">
      <div className="flex items-start gap-2.5 mb-1">
        <span className={`shrink-0 ${pal.text}`}>
          <HiveCell size={14} />
        </span>
        <span className="font-serif text-[15px] font-semibold text-fg leading-tight flex-1 min-w-0">
          {prompt.title}
        </span>
        <CopyButton text={prompt.body} />
      </div>
      <p className="text-[12.5px] text-fg-dim leading-[1.45] mb-2">{prompt.description}</p>
      <pre className="whitespace-pre-wrap font-mono text-[11.5px] bg-bg-elev border border-line rounded-lg p-2.5 text-fg-dim overflow-x-auto max-h-48 overflow-y-auto">
        {prompt.body}
      </pre>
    </div>
  )
}

export function ExamplePromptsSection() {
  const [open, setOpen] = useState(false)

  const grouped = ALL_CATEGORIES.map((category) => ({
    category,
    items: seedPrompts.filter((p) => p.category === category),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="shrink-0 border-t border-line bg-bg-elev">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-9 py-3 text-left hover:bg-bg-hi/50 transition-colors"
        aria-expanded={open}
      >
        <span className={`shrink-0 transition-transform text-fg-faint ${open ? 'rotate-90' : ''}`} aria-hidden>
          ▸
        </span>
        <span className="font-serif text-[17px] font-semibold text-fg">Example prompts</span>
        <span className="text-xs text-fg-faint">{seedPrompts.length} ready-to-use prompts</span>
      </button>

      {open && (
        <div className="max-h-[60vh] overflow-y-auto px-9 pb-6">
          {grouped.map(({ category, items }) => (
            <div key={category} className="mb-5">
              <div className="text-[10.5px] uppercase tracking-wider text-fg-faint font-semibold mb-2">
                {category}
              </div>
              <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                {items.map((p, i) => (
                  <ExamplePromptCard key={p.id} prompt={p} paletteIndex={i} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
