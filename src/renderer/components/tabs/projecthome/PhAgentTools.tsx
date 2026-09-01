/**
 * PhAgentTools — Project Home's third live block (after PhNow / PhOpenQuestions
 * in ProjectHome.tsx). Answers "what MCP tools can a session in THIS project
 * reach, and is this project actually wired up to use them?" — the gap that
 * left multiple sessions fumbling scheduler_create_prd / feedback_open_session
 * with nothing in the app to check against.
 *
 * Data comes entirely from useMcpAgentTools (catalog + delegation-readiness
 * over IPC) — this file never re-describes a tool or re-probes ~/.claude.json
 * itself; the catalog (src/main/lib/mcpToolCatalog.cjs) and
 * checkDelegationReadiness (src/main/lib/delegationReadiness.cjs) are the
 * single sources of truth.
 */
import { useEffect, useState } from 'react'
import { useMcpAgentTools } from '../../../lib/useMcpAgentTools'
import { toast } from '../../../state/toast'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { Badge } from '../../ui/Badge'
import { PhBlock, PhCard } from './ph-primitives'
import type { McpToolCatalogEntry, DelegationReadinessCheck } from '../../../../preload/api'

const GROUP_ORDER: McpToolCatalogEntry['group'][] = ['scheduler', 'chat', 'feedback', 'help']
const GROUP_LABELS: Record<McpToolCatalogEntry['group'], string> = {
  scheduler: 'Scheduler',
  chat: 'Chat',
  feedback: 'Feedback',
  help: 'Help',
}

function exampleCallFor(tool: McpToolCatalogEntry): string {
  return JSON.stringify({ tool: tool.name, arguments: tool.exampleArgs }, null, 2)
}

function ToolCard({ tool }: { tool: McpToolCatalogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = () => {
    window.api.clipboard
      .writeText(exampleCallFor(tool))
      .then(() => setCopied(true))
      .catch((err: unknown) => {
        toast.error(`Could not copy example call: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  return (
    <div data-testid={`agent-tool-${tool.name}`}>
      <PhCard className="px-4 py-3.5 grid gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <AlmanacIcon name="tool" size={13} className="text-fg-faint shrink-0" />
          <span className="font-mono text-[12px] font-semibold text-fg break-all">{tool.name}</span>
        </div>
        <p className="text-xs text-fg-dim leading-relaxed">{tool.purpose}</p>
        <p className="text-[11.5px] text-fg-faint leading-relaxed">
          <span className="font-semibold text-fg-dim">When to use — </span>
          {tool.whenToUse}
        </p>
        <p className="text-[11.5px] text-fg-faint leading-relaxed">
          <span className="font-semibold text-fg-dim">When NOT to use — </span>
          {tool.whenNotToUse}
        </p>
        <div>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent-dark hover:text-accent"
          >
            <AlmanacIcon name="chevron" size={10} className={expanded ? 'rotate-90' : ''} />
            {expanded ? 'Hide example call' : 'Show example call'}
          </button>
          {expanded && (
            <div className="mt-2 rounded-lg border border-line bg-bg-elev p-2.5 min-w-0">
              <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-fg-dim leading-relaxed">
                {exampleCallFor(tool)}
              </pre>
              <button
                type="button"
                onClick={handleCopy}
                className="mt-1.5 inline-flex items-center gap-1 rounded border border-line bg-bg-hi px-2 py-1 text-[10.5px] font-semibold text-fg-dim hover:text-fg"
              >
                <AlmanacIcon name={copied ? 'check' : 'copy'} size={11} />
                {copied ? 'Copied' : 'Copy example'}
              </button>
            </div>
          )}
        </div>
      </PhCard>
    </div>
  )
}

function ReadinessStrip({ checks }: { checks: DelegationReadinessCheck[] }) {
  if (checks.length === 0) return null
  return (
    <div className="mb-3.5 grid gap-1.5">
      {checks.map((c) => (
        <div
          key={c.id}
          data-testid={`agent-tools-readiness-${c.id}`}
          className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg-hi px-2.5 py-1.5 text-[11.5px]"
        >
          <Badge tone={c.ok ? 'good' : 'warn'}>{c.ok ? 'ready' : 'not ready'}</Badge>
          <span className="font-medium text-fg">{c.label}</span>
          {!c.ok && c.fix && <span className="text-fg-faint">— {c.fix}</span>}
        </div>
      ))}
    </div>
  )
}

export function PhAgentTools({ cwd }: { cwd: string }) {
  const { tools, checks, loaded, error } = useMcpAgentTools(cwd)

  if (!loaded) return null

  if (error || tools.length === 0) {
    return (
      <PhBlock
        kicker="tools"
        title="Agent tools"
        note="What the MCP tools available to this project's sessions actually do, and whether they're wired up."
      >
        <ReadinessStrip checks={checks} />
        <p className="text-xs text-fg-faint" data-testid="agent-tools-error">
          {error ?? 'No MCP tools were found in the catalog.'}
        </p>
      </PhBlock>
    )
  }

  const grouped = GROUP_ORDER
    .map((group) => ({ group, tools: tools.filter((t) => t.group === group) }))
    .filter((g) => g.tools.length > 0)

  return (
    <PhBlock
      kicker="tools"
      title="Agent tools"
      note="What the MCP tools available to this project's sessions actually do, and whether they're wired up."
    >
      <ReadinessStrip checks={checks} />
      <div className="grid gap-4">
        {grouped.map(({ group, tools: groupTools }) => (
          <div key={group} className="min-w-0">
            <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
              {GROUP_LABELS[group]}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {groupTools.map((tool) => (
                <ToolCard key={tool.name} tool={tool} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </PhBlock>
  )
}
