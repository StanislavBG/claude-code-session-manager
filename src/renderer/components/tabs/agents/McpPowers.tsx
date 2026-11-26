import { useEffect, useState } from 'react'
import type { ArmoryMcpItem, ToolRiskMark } from '../../../../preload/api'
import { useLayout } from '../../../state/layout'

/** The mark that applies to a tool: its exact rule, else its server's `mcp__<server>__*` rule. */
function markFor(marks: Record<string, ToolRiskMark>, serverId: string, toolId: string): ToolRiskMark | null {
  return marks[toolId] ?? marks[`mcp__${serverId}__*`] ?? null
}

/**
 * Frame 1f: the "Powers" panel of one equipped MCP server. Lists the server's armory tools with
 * checkboxes, All / None, risky badges and "n of m powers". It only reports the chosen tool ids;
 * GearPanel writes them (all = the whole-server grant equipServer writes, none = unequip).
 */
export function McpPowers({
  server, chosen, onChange, onClose,
}: {
  server: ArmoryMcpItem
  chosen: readonly string[]
  onChange: (ids: string[]) => void
  onClose: () => void
}) {
  const [marks, setMarks] = useState<Record<string, ToolRiskMark>>({})
  useEffect(() => {
    let live = true
    const api = (window as unknown as { api?: { toolRisk?: { read?: (i: { scope: 'user' }) => Promise<{ ok: boolean; marks?: Record<string, ToolRiskMark> }> } } }).api
    api?.toolRisk?.read?.({ scope: 'user' }).then((r) => { if (live && r?.ok) setMarks(r.marks ?? {}) }).catch(() => {})
    return () => { live = false }
  }, [])
  const all = server.tools.map((t) => t.id)
  const on = new Set(chosen)
  const n = all.filter((id) => on.has(id)).length
  const toggle = (id: string) => onChange(all.filter((x) => (x === id ? !on.has(x) : on.has(x))))
  const short = (id: string) => id.replace(`mcp__${server.id}__`, '')
  return (
    <div data-testid="agent-mcp-powers" data-server={server.id} className="rounded-[12px] border border-line bg-bg mt-1 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <div className="min-w-0 flex-1">
          <div data-testid="agent-mcp-powers-name" className="font-mono text-[13px] text-fg break-all">{server.label || server.id}</div>
          <div className="text-[11.5px] text-fg-dim">{server.status === 'checked' ? 'connected' : server.status === 'failing' ? 'failing' : 'not checked'}</div>
        </div>
        <span data-testid="agent-mcp-powers-count" className="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-fg-dim">{n} of {all.length} powers</span>
        <button type="button" data-testid="agent-mcp-powers-all" onClick={() => onChange(all)} className="shrink-0 px-2 h-6 rounded-md border border-line text-[11.5px]">All</button>
        <button type="button" data-testid="agent-mcp-powers-none" onClick={() => onChange([])} className="shrink-0 px-2 h-6 rounded-md border border-line text-[11.5px]">None</button>
        <button type="button" aria-label="Close powers" data-testid="agent-mcp-powers-close" onClick={onClose} className="px-1 text-fg-faint hover:text-fg">▴</button>
      </div>
      {server.status === 'not-checked' && (
        <div data-testid="agent-mcp-powers-unchecked" className="px-3 py-1.5 text-[11.5px] text-fg-faint border-b border-line">
          {all.length === 0 ? 'No tools known yet. ' : 'Showing known tools. '}
          <button type="button" data-testid="agent-mcp-powers-check" onClick={() => useLayout.getState().openPanel('claude-config', 'mcp')} className="underline text-fg-dim">Check in MCP</button>
        </div>
      )}
      {server.tools.map((t) => (
        <label key={t.id} data-power={t.id} className="flex items-center gap-2 px-3 py-1.5 border-t border-line first:border-t-0 text-[12.5px] cursor-pointer">
          <input type="checkbox" checked={on.has(t.id)} onChange={() => toggle(t.id)} />
          <span title={t.id} className={`min-w-0 flex-1 truncate ${on.has(t.id) ? 'text-fg' : 'text-fg-dim'}`}>{t.label === t.id ? short(t.id) : t.label}</span>
          {(() => {
            const m = markFor(marks, server.id, t.id)
            return m && m !== 'read' ? <span data-badge="risky" data-mark={m} className="shrink-0 px-1 rounded text-[9.5px] uppercase tracking-wide bg-red-500/15 text-red-700">{m}</span> : null
          })()}
        </label>
      ))}
      <div className="px-3 py-2 text-[11px] text-fg-faint border-t border-line">
        Writes tools: {n} × mcp__{server.id}__… and mcpServers: {server.id} — derived from the tools, so the two can't drift.
      </div>
    </div>
  )
}
