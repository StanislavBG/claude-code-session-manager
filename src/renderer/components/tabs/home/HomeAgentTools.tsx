/**
 * HomeAgentTools — collapsed-by-default, extremely abridged MCP tool catalog on
 * the machine-wide Dashboard: each tool's name + a one-line purpose, nothing
 * else. Replaces the old Project Home "Agent tools" block; the catalog is
 * cwd-independent, so it belongs here. Per-project delegation readiness lives
 * in NewEpicCard's readiness banner, not here.
 */
import { useState } from 'react'
import { useMcpCatalog } from '../../../lib/useMcpAgentTools'
import type { McpToolCatalogEntry } from '../../../../preload/api'

const GROUP_ORDER: McpToolCatalogEntry['group'][] = ['scheduler', 'chat', 'feedback', 'help']
const GROUP_LABELS: Record<McpToolCatalogEntry['group'], string> = {
  scheduler: 'Scheduler',
  chat: 'Chat',
  feedback: 'Feedback',
  help: 'Help',
}

export function HomeAgentTools() {
  const { tools, loaded, error } = useMcpCatalog()
  const [open, setOpen] = useState(false)

  if (!loaded) return null

  if (error || tools.length === 0) {
    return (
      <section className="mb-6" data-testid="home-agent-tools">
        <h2 className="m-0 mb-2 font-serif text-[22px] font-medium">Agent tools</h2>
        <p className="m-0 text-xs text-fg-faint" data-testid="home-agent-tools-error">
          The MCP tool catalog is unavailable.
        </p>
      </section>
    )
  }

  const grouped = GROUP_ORDER
    .map((group) => ({ group, tools: tools.filter((t) => t.group === group) }))
    .filter((g) => g.tools.length > 0)

  return (
    <section className="mb-6" data-testid="home-agent-tools">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="home-agent-tools-toggle"
        className="flex w-full items-baseline gap-2 text-left"
      >
        <span className="font-serif text-[22px] font-medium">Agent tools</span>
        <span className="font-mono text-[12px] text-fg-faint">
          · {tools.length} MCP tools {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="mt-3 grid gap-3 border border-line rounded-xl bg-bg-hi px-5 py-4">
          {grouped.map(({ group, tools: groupTools }) => (
            <div key={group} className="min-w-0">
              <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
                {GROUP_LABELS[group]}
              </div>
              {groupTools.map((tool) => (
                <div
                  key={tool.name}
                  data-testid={`home-agent-tool-${tool.name}`}
                  className="flex items-baseline gap-3 min-w-0 py-0.5"
                >
                  <span className="shrink-0 font-mono text-[12px] font-semibold text-fg">{tool.name}</span>
                  <span
                    data-testid="home-agent-tool-purpose"
                    title={tool.purpose}
                    className="min-w-0 line-clamp-1 text-xs text-fg-dim"
                  >
                    {tool.purpose}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
