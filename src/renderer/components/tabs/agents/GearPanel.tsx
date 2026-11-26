import { useEffect, useState, type ReactNode } from 'react'
import { useToast } from '../../../state/toast'
import type { Armory, ArmoryItem, ArmoryMcpItem, ArmoryPackItem } from '../../../../preload/api'
import { TOOLS, type Draft } from './AgentDetail'
import { McpPowers } from './McpPowers'
import { ArmoryDrawer, type ArmoryKind } from './ArmoryDrawer'

/**
 * The Gear card of the agent sheet (frame 1b): Built-in tools (equipped solid / available dashed,
 * click toggles; the always-granted floor as fixed chips), MCP servers, Packs and the Companions slot.
 * Every edit goes through `set` into the draft Save writes. Equipping or removing an MCP server keeps
 * `mcpServers` and its `mcp__<server>__<tool>` tool entries in step (whole server = all its tools).
 * Drag-and-drop and the Armory drawer are a later PRD; here "equip" is a select in the dashed slot.
 */

const MCP_PREFIX = (server: string) => `mcp__${server}__`

export function serversOfTools(tools: readonly string[]): string[] {
  const s = new Set<string>()
  for (const t of tools) {
    const m = /^mcp__(.+?)__/.exec(t)
    if (m) s.add(m[1])
  }
  return [...s]
}

const isUnbound = (tools: readonly string[]) => tools.length === 0 || tools.includes('*')

function SubLabel({ children }: { children: ReactNode }) {
  return <div className="font-serif italic text-[12px] text-fg-faint font-normal">{children}</div>
}

function Badges({ badges }: { badges: ArmoryItem['badges'] }) {
  return (
    <>
      {badges.includes('risky') && <span data-badge="risky" className="ml-1 px-1 rounded text-[9.5px] uppercase tracking-wide bg-honey/20 text-honey-dark">risky</span>}
      {badges.includes('banned') && <span data-badge="banned" className="ml-1 px-1 rounded text-[9.5px] uppercase tracking-wide bg-red-500/15 text-red-700">banned</span>}
    </>
  )
}

interface DropProps { kind: ArmoryKind; dragging: { kind: ArmoryKind; id: string } | null; onDrop: () => void }

function Row({ testid, title, sub, children, drop }: { testid: string; title: string; sub: string; children: ReactNode; drop?: DropProps }) {
  const [over, setOver] = useState(false)
  const target = !!drop && drop.dragging?.kind === drop.kind
  return (
    <div
      data-testid={testid}
      data-drop-target={target ? (over ? 'over' : 'ready') : undefined}
      onDragOver={target ? (e) => { e.preventDefault(); setOver(true) } : undefined}
      onDragLeave={target ? () => setOver(false) : undefined}
      onDrop={drop ? (e) => { e.preventDefault(); setOver(false); drop.onDrop() } : undefined}
      className={`relative grid grid-cols-[132px_1fr] gap-3 py-3 border-t border-line first:border-t-0 ${target ? `rounded-[12px] border border-dashed border-honey/60 ${over ? 'bg-honey/15' : 'bg-honey/5'}` : ''}`}
    >
      {target && over && <span data-testid="agent-release-hint" className="absolute right-2 top-1 text-[11px] font-semibold text-honey-dark">Release to equip</span>}
      <div><div className="text-[13px] font-semibold text-fg">{title}</div><SubLabel>{sub}</SubLabel></div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const STATUS: Record<ArmoryMcpItem['status'], { dot: string; text: string }> = {
  checked: { dot: 'bg-green-600', text: 'connected' },
  failing: { dot: 'bg-red-600', text: 'failing' },
  'not-checked': { dot: 'bg-fg-faint', text: 'not checked' },
}

export function GearPanel({ obj, set }: { obj: Draft; set: (patch: Partial<Draft>) => void }) {
  const [armory, setArmory] = useState<Armory | null>(null)
  const [open, setOpen] = useState(false)
  const [powersOf, setPowersOf] = useState<string | null>(null)
  const [dragging, setDragging] = useState<{ kind: ArmoryKind; id: string } | null>(null)

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const a = await window.api.agents.armory({})
        if (live) setArmory(a)
      } catch (e) {
        useToast.getState().show('error', `Could not load the armory: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    void load()
    const off = window.api.agents.onChanged?.(() => { void load() })
    return () => { live = false; off?.() }
  }, [])

  const unbound = isUnbound(obj.tools)
  const floorIds = new Set((armory?.builtins ?? []).filter((b) => b.badges.includes('floor')).map((b) => b.id))
  const builtins: ArmoryItem[] = armory
    ? armory.builtins.filter((b) => !floorIds.has(b.id))
    : TOOLS.map((id) => ({ id, label: id, badges: [] }))
  const floor = armory ? armory.builtins.filter((b) => floorIds.has(b.id)) : []

  const toggleTool = (id: string) => {
    if (unbound) {
      set({ tools: [...builtins.map((b) => b.id).filter((x) => x !== id), ...obj.tools.filter((t) => t.startsWith('mcp__'))] })
      return
    }
    set({ tools: obj.tools.includes(id) ? obj.tools.filter((x) => x !== id) : [...obj.tools, id] })
  }

  // ---- MCP servers: draft.mcpServers (explicit) ∪ servers named by mcp__ tools
  const servers = [...new Set([...(obj.mcpServers ?? []), ...serversOfTools(obj.tools)])]
  const armoryServer = (id: string) => armory?.mcpServers.find((s) => s.id === id)
  const availableServers = (armory?.mcpServers ?? []).filter((s) => !servers.includes(s.id))

  const equipServer = (s: ArmoryMcpItem) => {
    const next = unbound ? obj.tools : [...new Set([...obj.tools, ...s.tools.map((t) => t.id)])]
    set({ tools: next, mcpServers: [...servers, s.id] })
  }
  const removeServer = (id: string) => {
    const base = unbound ? [...builtins.map((b) => b.id), ...floor.map((f) => f.id)] : obj.tools
    set({ tools: base.filter((t) => !t.startsWith(MCP_PREFIX(id))), mcpServers: servers.filter((x) => x !== id) })
  }

  // Powers panel: a subset writes exactly those tool ids, all = whole-server grant, none = unequip.
  const setPowers = (s: ArmoryMcpItem, ids: string[]) => {
    if (ids.length === 0) {
      if (typeof window.confirm === 'function' && !window.confirm(`Unequip ${s.id}? Choosing no powers removes the server from this agent.`)) return
      removeServer(s.id)
      setPowersOf(null)
      return
    }
    const base = unbound ? [...builtins.map((b) => b.id), ...floor.map((f) => f.id), ...obj.tools.filter((t) => t.startsWith('mcp__'))] : obj.tools
    set({ tools: [...new Set([...base.filter((t) => !t.startsWith(MCP_PREFIX(s.id))), ...ids])], mcpServers: servers.includes(s.id) ? servers : [...servers, s.id] })
  }

  // ---- Packs
  const packs = obj.packs ?? []
  const availablePacks = (armory?.packs ?? []).filter((p) => !packs.includes(p.id))
  const armoryPack = (id: string): ArmoryPackItem | undefined => armory?.packs.find((p) => p.id === id)

  // ---- Armory drawer: explicit equip / unequip per kind (drag, button and Enter all land here)
  const equipItem = (kind: ArmoryKind, id: string) => {
    if (kind === 'builtin') { if (!unbound && !obj.tools.includes(id)) set({ tools: [...obj.tools, id] }) }
    else if (kind === 'mcp') { const s = armoryServer(id); if (s && !servers.includes(id)) equipServer(s) }
    else if (!packs.includes(id)) set({ packs: [...packs, id] })
  }
  const unequipItem = (kind: ArmoryKind, id: string) => {
    if (kind === 'builtin') { if (unbound || obj.tools.includes(id)) toggleTool(id) }
    else if (kind === 'mcp') removeServer(id)
    else set({ packs: packs.filter((x) => x !== id) })
  }
  const dropOn = (kind: ArmoryKind) => () => {
    const d = dragging
    setDragging(null)
    if (d && d.kind === kind) equipItem(d.kind, d.id)
  }
  const dropProps = (kind: ArmoryKind): DropProps => ({ kind, dragging, onDrop: dropOn(kind) })

  // Escape cancels a drag in flight; otherwise it closes the drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (dragging) setDragging(null)
      else setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dragging])

  const slot = 'rounded-[12px] border border-dashed border-rule px-3 py-2 text-[12px] text-fg-faint flex items-center'

  return (
    <section data-testid="agent-gear-slot" className="px-[18px] py-4 rounded-[14px] bg-bg-hi border border-line flex flex-col">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint mb-1">
        <span className="flex items-center gap-2">
          <span className="flex-1">Gear <span className="font-serif italic normal-case tracking-normal font-normal text-fg-dim">inventory</span></span>
          <button
            type="button"
            data-testid="agent-open-armory"
            aria-expanded={open}
            onClick={() => { setOpen((o) => !o); setDragging(null) }}
            className="h-7 px-2.5 rounded-[10px] border border-line bg-bg text-[12px] font-medium normal-case tracking-normal text-fg hover:border-rule"
          >
            {open ? 'Armory open' : 'Open Armory'}
          </button>
        </span>
      </div>

      <Row testid="agent-tools-row" title="Built-in tools" sub="class abilities" drop={dropProps('builtin')}>
        <div className="flex flex-wrap gap-1.5">
          {builtins.map((b) => {
            const on = unbound || obj.tools.includes(b.id)
            return (
              <button
                key={b.id}
                type="button"
                aria-pressed={on}
                data-tool={b.id}
                onClick={() => toggleTool(b.id)}
                className={`px-2 py-0.5 rounded-md text-[12px] font-mono border ${
                  on ? 'bg-honey/20 text-honey-dark border-honey/40' : 'bg-transparent text-fg-faint border-dashed border-rule'
                }`}
              >
                {b.label}<Badges badges={b.badges} />
              </button>
            )
          })}
        </div>
        {floor.length > 0 && (
          <div data-testid="agent-floor-row" className="flex flex-wrap items-center gap-1.5 mt-2">
            <span className="text-[11.5px] text-fg-faint mr-1">Always granted</span>
            {floor.map((f) => (
              <span key={f.id} data-floor={f.id} className="px-2 py-0.5 rounded-md text-[12px] font-mono border border-line bg-bg text-fg-dim cursor-default">{f.label}</span>
            ))}
          </div>
        )}
        <div data-testid="agent-tools-note" className="text-[11px] text-fg-faint mt-1 leading-snug">
          {unbound ? (
            'All tools — no tools: line, so every tool (MCP included) is granted. Click one to restrict.'
          ) : (
            <>
              {obj.tools.filter((t) => !t.startsWith('mcp__')).length} of {builtins.length + floor.length} built-ins granted. Anything not filled is refused at call time.{' '}
              <button type="button" data-testid="agent-tools-all" onClick={() => set({ tools: [] })} className="underline text-fg-dim hover:text-fg">
                Grant all tools
              </button>
            </>
          )}
        </div>
      </Row>

      <Row testid="agent-mcp-row" title="MCP servers" sub="magic items" drop={dropProps('mcp')}>
        <div className="flex flex-col gap-2">
          {servers.map((id) => {
            const a = armoryServer(id)
            const st = STATUS[a?.status ?? 'not-checked']
            const total = a?.tools.length ?? 0
            const have = unbound ? total : obj.tools.filter((t) => t.startsWith(MCP_PREFIX(id))).length
            return (
              <div key={id}>
              <div data-testid="agent-mcp-item" data-server={id} className="rounded-[12px] border border-line bg-bg px-3 py-2 flex items-center gap-2 min-w-0">
                <div className="min-w-0 flex-1">
                  <div title={id} className="font-mono text-[13px] font-semibold text-fg truncate">{id}<Badges badges={a?.badges ?? []} /></div>
                  <div className="text-[11.5px] text-fg-dim flex items-center gap-1.5">
                    <span data-testid="agent-mcp-dot" className={`inline-block w-1.5 h-1.5 rounded-full ${st.dot}`} />
                    {st.text}{a ? ` · ${have} of ${total} powers` : ''}
                  </div>
                  {obj.tools.filter((t) => t.startsWith(MCP_PREFIX(id))).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {obj.tools.filter((t) => t.startsWith(MCP_PREFIX(id))).map((t) => (
                        <span key={t} data-mcp-tool={t} title={t} className="max-w-[220px] truncate px-1.5 rounded text-[10.5px] font-mono bg-bg-hi border border-line text-fg-faint">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                {a && (
                  <button type="button" data-testid="agent-mcp-powers-open" aria-expanded={powersOf === id} onClick={() => setPowersOf(powersOf === id ? null : id)} className="text-[12px] text-fg-dim hover:text-fg px-1">Powers ›</button>
                )}
                <button type="button" aria-label={`Remove ${id}`} data-testid="agent-mcp-remove" onClick={() => removeServer(id)} className="text-fg-faint hover:text-fg px-1">×</button>
              </div>
              {a && powersOf === id && (
                <McpPowers server={a} chosen={unbound ? a.tools.map((t) => t.id) : obj.tools} onChange={(ids) => setPowers(a, ids)} onClose={() => setPowersOf(null)} />
              )}
              </div>
            )
          })}
          <div data-testid="agent-mcp-slot" className={slot}>
            {availableServers.length > 0 ? (
              <select
                aria-label="Equip an MCP server"
                data-testid="agent-mcp-equip"
                value=""
                onChange={(e) => { const s = availableServers.find((x) => x.id === e.target.value); if (s) equipServer(s) }}
                className="bg-transparent text-[12px] text-fg-dim w-full"
              >
                <option value="">+ Equip an MCP server</option>
                {availableServers.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            ) : '+ Drop an MCP server'}
          </div>
        </div>
      </Row>

      <Row testid="agent-packs-row" title="Packs" sub="spellbooks" drop={dropProps('pack')}>
        <div className="flex flex-col gap-2">
          {packs.map((id) => {
            const p = armoryPack(id)
            return (
              <div key={id} data-testid="agent-pack-item" data-pack={id} className="rounded-[12px] border border-line bg-bg px-3 py-2 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div title={id} className="font-mono text-[13px] font-semibold text-fg truncate">{id}</div>
                  {p && <div className="text-[11.5px] text-fg-dim">{p.source ? `${p.source} · ` : ''}{p.skills.length} skills</div>}
                  {p && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {p.skills.map((s) => <span key={s} className="px-1.5 rounded text-[10.5px] font-mono bg-bg-hi border border-line text-fg-dim">/{s}</span>)}
                    </div>
                  )}
                </div>
                <button type="button" aria-label={`Remove ${id}`} data-testid="agent-pack-remove" onClick={() => set({ packs: packs.filter((x) => x !== id) })} className="text-fg-faint hover:text-fg px-1">×</button>
              </div>
            )
          })}
          <div data-testid="agent-pack-slot" className={slot}>
            {availablePacks.length > 0 ? (
              <select
                aria-label="Equip a pack"
                data-testid="agent-pack-equip"
                value=""
                onChange={(e) => { if (e.target.value) set({ packs: [...packs, e.target.value] }) }}
                className="bg-transparent text-[12px] text-fg-dim w-full"
              >
                <option value="">+ Equip a pack</option>
                {availablePacks.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            ) : '+ Drop a pack'}
          </div>
        </div>
      </Row>

      <Row testid="agent-companions-row" title="Companions" sub="party">
        <div data-testid="agent-companions-slot" className={slot}>Other agents it can call — designed later, not part of this build</div>
      </Row>
      {open && (
        <ArmoryDrawer
          armory={armory}
          equipped={{ allBuiltins: unbound, builtins: obj.tools, servers, packs }}
          onEquip={equipItem}
          onUnequip={unequipItem}
          onDragStart={(kind, id) => setDragging({ kind, id })}
          onDragEnd={() => setDragging(null)}
          onClose={() => { setOpen(false); setDragging(null) }}
        />
      )}
    </section>
  )
}
