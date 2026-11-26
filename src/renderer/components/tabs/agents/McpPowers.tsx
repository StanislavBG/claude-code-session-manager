import type { ArmoryMcpItem } from '../../../../preload/api'

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
  const all = server.tools.map((t) => t.id)
  const on = new Set(chosen)
  const n = all.filter((id) => on.has(id)).length
  const toggle = (id: string) => onChange(all.filter((x) => (x === id ? !on.has(x) : on.has(x))))
  const short = (id: string) => id.replace(`mcp__${server.id}__`, '')
  return (
    <div data-testid="agent-mcp-powers" data-server={server.id} className="rounded-[12px] border border-line bg-bg mt-1 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <div className="min-w-0 flex-1 text-[11.5px] text-fg-dim">
          {server.status === 'checked' ? 'connected' : server.status === 'failing' ? 'failing' : 'not checked'}
        </div>
        <span data-testid="agent-mcp-powers-count" className="font-mono text-[11.5px] text-fg-dim">{n} of {all.length} powers</span>
        <button type="button" data-testid="agent-mcp-powers-all" onClick={() => onChange(all)} className="px-2 h-6 rounded-md border border-line text-[11.5px]">All</button>
        <button type="button" data-testid="agent-mcp-powers-none" onClick={() => onChange([])} className="px-2 h-6 rounded-md border border-line text-[11.5px]">None</button>
        <button type="button" aria-label="Close powers" data-testid="agent-mcp-powers-close" onClick={onClose} className="px-1 text-fg-faint hover:text-fg">▴</button>
      </div>
      {server.status === 'not-checked' && (
        <div data-testid="agent-mcp-powers-unchecked" className="px-3 py-1.5 text-[11.5px] text-fg-faint border-b border-line">
          {all.length === 0 ? 'No tools known yet. ' : 'Showing known tools. '}
          <a href="#mcp" data-testid="agent-mcp-powers-check" className="underline text-fg-dim">Check in MCP</a>
        </div>
      )}
      {server.tools.map((t) => (
        <label key={t.id} data-power={t.id} className="flex items-center gap-2 px-3 py-1.5 border-t border-line first:border-t-0 text-[12.5px] cursor-pointer">
          <input type="checkbox" checked={on.has(t.id)} onChange={() => toggle(t.id)} />
          <span className={`flex-1 truncate ${on.has(t.id) ? 'text-fg' : 'text-fg-dim'}`}>{t.label === t.id ? short(t.id) : t.label}</span>
          <span title={t.id} className="font-mono text-[11px] text-fg-faint truncate max-w-[220px]">{t.id}</span>
          {t.badges.includes('risky') && <span data-badge="risky" className="px-1 rounded text-[9.5px] uppercase tracking-wide bg-honey/20 text-honey-dark">irreversible</span>}
        </label>
      ))}
      <div className="px-3 py-2 text-[11px] text-fg-faint border-t border-line">
        Writes tools: {n} × mcp__{server.id}__… and mcpServers: {server.id} — derived from the tools, so the two can't drift.
      </div>
    </div>
  )
}
