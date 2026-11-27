import { useEffect, useState, type ReactNode } from 'react'
import { useToast } from '../../../state/toast'
import type { Armory, ArmoryItem, ArmoryMcpItem, ArmoryPackItem } from '../../../../preload/api'
import { TOOLS, type Draft } from './AgentDetail'
import { McpPowers } from './McpPowers'
import { RiskBadge } from './RiskBadge'
import { ArmoryDrawer, type ArmoryKind, type KindTab } from './ArmoryDrawer'

/**
 * The Gear card of the agent sheet (frame 1b): Built-in tools (equipped solid / available dashed,
 * click toggles; the always-granted floor as fixed chips), MCP servers, Packs and the Companions slot.
 * Every edit goes through `set` into the draft Save writes. Equipping or removing an MCP server keeps
 * `mcpServers` and its `mcp__<server>__<tool>` tool entries in step (whole server = all its tools).
 * Empty dashed slots (and the hint) open the Armory drawer; drag-and-drop equips into a row.
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

/** Every tool granted: an explicit Unbound loadout (or a '*' entry) or an Undecided draft (which runs with every tool). Never inferred from an empty tools list. */
const allGranted = (d: Pick<Draft, 'tools' | 'loadout'>) => d.loadout === 'unbound' || d.loadout === 'undecided' || d.tools.includes('*')

function SubLabel({ children }: { children: ReactNode }) {
  return <div className="font-serif italic text-[12px] text-fg-faint font-normal">{children}</div>
}

function Badges({ badges }: { badges: ArmoryItem['badges'] }) {
  return (
    <>
      {badges.includes('risky') && <RiskBadge className="ml-1">risky</RiskBadge>}
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
      onDragEnter={target ? (e) => { e.preventDefault(); setOver(true) } : undefined}
      onDragOver={target ? (e) => { e.preventDefault(); setOver(true) } : undefined}
      onDragLeave={target ? () => setOver(false) : undefined}
      onDrop={drop ? (e) => { e.preventDefault(); setOver(false); drop.onDrop() } : undefined}
      className={`relative grid grid-cols-[132px_1fr] gap-3 py-3 border-t border-line first:border-t-0 ${target ? `rounded-[12px] border border-dashed border-accent/60 ${over ? 'bg-accent/15' : 'bg-accent/5'}` : ''}`}
    >
      {target && over && <span data-testid="agent-release-hint" className="absolute right-2 top-1 text-[11px] font-semibold text-accent-dark">Release to equip</span>}
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

export function GearPanel({ obj, set, baseline, onRestore, projectName, onOpenChange }: {
  /** Reports the Armory drawer's open state (the Constraints card collapses while it is open). */
  onOpenChange?: (open: boolean) => void
  obj: Draft
  set: (patch: Partial<Draft>) => void
  /** Project mode only: the global draft to mark added/removed items against. */
  baseline?: Draft
  /** Project mode only: removes these keys from the overlay (the item goes back to the global list). */
  onRestore?: (keys: Array<'tools' | 'mcpServers' | 'packs'>) => void
  projectName?: string
}) {
  const [armory, setArmory] = useState<Armory | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { onOpenChange?.(open) }, [open, onOpenChange])
  useEffect(() => () => { onOpenChange?.(false) }, [onOpenChange])
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

  const unbound = allGranted(obj)
  const undecided = obj.loadout === 'undecided' && !obj.tools.includes('*')
  const bare = !unbound && obj.loadout === 'bare'
  const marking = !!baseline && !!onRestore
  const baseTools = baseline?.tools ?? []
  const baseBound = marking && !allGranted(baseline!)
  const baseServers = marking ? [...new Set([...(baseline?.mcpServers ?? []), ...serversOfTools(baseTools)])] : []
  const basePacks = marking ? (baseline?.packs ?? []) : []
  const restore = (keys: Array<'tools' | 'mcpServers' | 'packs'>) => onRestore?.(keys)
  const restoreBtn = (testid: string, keys: Array<'tools' | 'mcpServers' | 'packs'>) => (
    <button type="button" data-testid={testid} onClick={() => restore(keys)} className="text-[12px] text-accent hover:underline px-1">Restore</button>
  )
  const floorIds = new Set((armory?.builtins ?? []).filter((b) => b.badges.includes('floor')).map((b) => b.id))
  const builtins: ArmoryItem[] = armory
    ? armory.builtins.filter((b) => !floorIds.has(b.id))
    : TOOLS.map((id) => ({ id, label: id, badges: [] }))
  const floor = armory ? armory.builtins.filter((b) => floorIds.has(b.id)) : []

  const toggleTool = (id: string) => {
    if (unbound) {
      set({ loadout: 'equipped', tools: [...builtins.map((b) => b.id).filter((x) => x !== id), ...obj.tools.filter((t) => t.startsWith('mcp__'))] })
      return
    }
    set({ tools: obj.tools.includes(id) ? obj.tools.filter((x) => x !== id) : [...obj.tools, id] })
  }

  // ---- MCP servers: draft.mcpServers (explicit) ∪ servers named by mcp__ tools
  const servers = [...new Set([...(obj.mcpServers ?? []), ...serversOfTools(obj.tools)])]
  const armoryServer = (id: string) => armory?.mcpServers.find((s) => s.id === id)

  const equipServer = (s: ArmoryMcpItem) => {
    const next = unbound ? obj.tools : [...new Set([...obj.tools, ...s.tools.map((t) => t.id)])]
    set({ tools: next, mcpServers: [...servers, s.id], ...(unbound ? { loadout: obj.loadout } : {}) })
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

  const [armoryTab, setArmoryTab] = useState<KindTab>('all')
  const openArmory = (kind?: ArmoryKind) => { setArmoryTab(kind ?? 'all'); setOpen(true); setDragging(null) }

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

      <div data-testid="agent-gear-hint" className="text-[11.5px] text-fg-faint mb-1">
        Drag items here from the Armory, or{' '}
        <button type="button" data-testid="agent-gear-hint-open" onClick={() => openArmory()} className="underline text-fg-dim hover:text-fg">Open Armory</button>
      </div>

      <Row testid="agent-tools-row" title="Built-in tools" sub="class abilities" drop={dropProps('builtin')}>
        <div className="flex flex-wrap gap-1.5">
          {builtins.map((b) => {
            const on = unbound || obj.tools.includes(b.id)
            const added = baseBound && on && !unbound && !baseTools.includes(b.id)
            const removed = baseBound && !on && baseTools.includes(b.id)
            if (removed) {
              return (
                <span key={b.id} data-tool={b.id} data-marker="removed" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-mono border border-dashed border-rule bg-transparent text-fg-faint">
                  <span className="line-through">{b.label}</span><span className="text-[10px]">− removed</span>{restoreBtn('agent-restore-tool', ['tools'])}
                </span>
              )
            }
            return (
              <button
                key={b.id}
                type="button"
                aria-pressed={on}
                data-tool={b.id}
                data-marker={added ? 'added' : undefined}
                onClick={() => toggleTool(b.id)}
                className={`px-2 py-0.5 rounded-md text-[12px] font-mono border ${
                  added ? 'bg-bg text-accent border-accent' : on ? 'bg-bg text-fg border-rule' : 'bg-transparent text-fg-faint border-dashed border-rule'
                }`}
              >
                {added && '+'}{b.label}<Badges badges={b.badges} />
              </button>
            )
          })}
        </div>
        {floor.length > 0 && (
          <div data-testid="agent-floor-row" className="flex flex-wrap items-center gap-1.5 mt-2">
            <span className="text-[11.5px] text-fg-faint mr-1">Always granted</span>
            {floor.map((f) => (
              <span key={f.id} data-floor={f.id} className="px-2 py-0.5 rounded-md text-[12px] font-mono border border-line bg-bg text-fg-dim cursor-default">{f.label}<span className="ml-1 px-1 rounded text-[9.5px] uppercase tracking-wide bg-bg-hi text-fg-faint">floor</span></span>
            ))}
          </div>
        )}
        <div data-testid="agent-tools-note" className="text-[11px] text-fg-faint mt-1 leading-snug">
          {unbound ? (
            undecided
              ? 'Undecided — no loadout chosen, so it runs with every tool (MCP included). Click one to restrict.'
              : 'All tools — every tool (MCP included) is granted. Click one to restrict.'
          ) : (
            <>
              {bare && <span data-testid="agent-tools-bare">Bare — floor only. </span>}
              {obj.tools.filter((t) => !t.startsWith('mcp__')).length} of {builtins.length + floor.length} built-ins granted. Anything not filled is refused at call time.{' '}
              <button type="button" data-testid="agent-tools-all" onClick={() => set({ loadout: 'unbound', tools: ['*'] })} className="underline text-fg-dim hover:text-fg">
                Grant all tools
              </button>
            </>
          )}
        </div>
      </Row>

      <Row testid="agent-mcp-row" title="MCP servers" sub="magic items" drop={dropProps('mcp')}>
        <div className="flex flex-col gap-2">
          {baseServers.filter((id) => !servers.includes(id)).map((id) => (
            <div key={`removed-${id}`} data-testid="agent-mcp-removed" data-server={id} data-marker="removed" className="rounded-[12px] border border-dashed border-rule bg-bg px-3 py-2 flex items-center gap-2 min-w-0 text-fg-faint">
              <div className="min-w-0 flex-1">
                <div title={id} className="font-mono text-[13px] font-semibold truncate line-through">{id}</div>
                <div className="text-[11.5px]">− removed{projectName ? ` in ${projectName}` : ''}</div>
              </div>
              {restoreBtn('agent-restore-mcp', ['tools', 'mcpServers'])}
            </div>
          ))}
          {servers.map((id) => {
            const a = armoryServer(id)
            const addedServer = marking && !baseServers.includes(id)
            const st = STATUS[a?.status ?? 'not-checked']
            const total = a?.tools.length ?? 0
            const have = unbound ? total : obj.tools.filter((t) => t.startsWith(MCP_PREFIX(id))).length
            return (
              <div key={id}>
              <div data-testid="agent-mcp-item" data-server={id} data-marker={addedServer ? 'added' : undefined} className="rounded-[12px] border border-line bg-bg px-3 py-2 flex items-center gap-2 min-w-0">
                <div className="min-w-0 flex-1">
                  <div title={id} className="font-mono text-[13px] font-semibold text-fg truncate">{addedServer && <span className="text-accent">+ </span>}{id}<Badges badges={a?.badges ?? []} /></div>
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
          <button type="button" data-testid="agent-mcp-slot" data-slot-kind="mcp" onClick={() => openArmory('mcp')} className={`${slot} w-full text-left`}>Drop an MCP server</button>
        </div>
      </Row>

      <Row testid="agent-packs-row" title="Packs" sub="spellbooks" drop={dropProps('pack')}>
        <div className="flex flex-col gap-2">
          {basePacks.filter((id) => !packs.includes(id)).map((id) => (
            <div key={`removed-${id}`} data-testid="agent-pack-removed" data-pack={id} data-marker="removed" className="rounded-[12px] border border-dashed border-rule bg-bg px-3 py-2 flex items-center gap-2 text-fg-faint">
              <div className="min-w-0 flex-1"><div className="font-mono text-[13px] font-semibold truncate line-through">{id}</div><div className="text-[11.5px]">− removed{projectName ? ` in ${projectName}` : ''}</div></div>
              {restoreBtn('agent-restore-pack', ['packs'])}
            </div>
          ))}
          {packs.map((id) => {
            const p = armoryPack(id)
            const addedPack = marking && !basePacks.includes(id)
            return (
              <div key={id} data-testid="agent-pack-item" data-pack={id} data-marker={addedPack ? 'added' : undefined} className="rounded-[12px] border border-line bg-bg px-3 py-2 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div title={id} className="font-mono text-[13px] font-semibold text-fg truncate">{addedPack && <span className="text-accent">+ </span>}{id}</div>
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
          <button type="button" data-testid="agent-pack-slot" data-slot-kind="pack" onClick={() => openArmory('pack')} className={`${slot} w-full text-left`}>Drop a pack</button>
        </div>
      </Row>

      <Row testid="agent-companions-row" title="Companions" sub="party">
        <div data-testid="agent-companions-slot" className={slot}>Other agents it can call — designed later, not part of this build</div>
      </Row>
      {open && (
        <ArmoryDrawer
          initialTab={armoryTab}
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
