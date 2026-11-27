import { useEffect, useRef, useState } from 'react'
import type { Armory } from '../../../../preload/api'
import { ArmoryDrawer, type ArmoryKind } from './ArmoryDrawer'
import type { Draft } from './AgentDetail'
import type { AgentPersona } from '../../../../preload/api'

/**
 * First-run choice for an Undecided agent (frame 1g): Bare (floor only), Pick gear (opens the Armory
 * with an empty Equipped loadout) or Unbound (every tool). Choices only edit the draft — the sheet's
 * normal save bar persists them. Disappears once the draft is decided (or "Not now").
 * Draft encodings: Unbound = tools ['*']; Bare = tools [] + loadout 'bare'; Equipped = the picked tools.
 */

const MCP = (id: string) => `mcp__${id}__`

/** True once the draft carries a decision (a choice made here, or tools edited away from the saved ones). */
export function isDecided(obj: Draft, savedTools: readonly string[]): boolean {
  return obj.loadout !== 'undecided' || JSON.stringify(obj.tools) !== JSON.stringify(savedTools)
}

/** Whether the first-run choice replaces the Gear panel (AgentSheet renders one or the other). */
export function showsFirstRun(undecided: boolean, obj: Draft, savedTools: readonly string[], picking: boolean, dismissed: boolean): boolean {
  return undecided && !dismissed && (picking || !isDecided(obj, savedTools))
}

type Props = {
  obj: Draft
  set: (patch: Partial<Draft>) => void
  picking: boolean
  setPicking: (v: boolean) => void
  onDismiss: () => void
}

export function LoadoutFirstRun({ obj, set, picking, setPicking, onDismiss }: Props) {
  const [armory, setArmory] = useState<Armory | null>(null)
  const loadedPersonas = useRef(false)
  const [personas, setPersonas] = useState<AgentPersona[]>([])
  useEffect(() => {
    let live = true
    Promise.resolve(window.api.agents.armory?.({})).then((a) => { if (live && a) setArmory(a) }).catch(() => {})
    return () => { live = false }
  }, [])
  // Persona list loads on first touch of the picker, so merely showing the choice adds no fetch.
  const loadPersonas = () => {
    if (loadedPersonas.current) return
    loadedPersonas.current = true
    Promise.resolve(window.api.agents.listPersonas?.()).then((l) => { if (Array.isArray(l)) setPersonas(l) }).catch(() => {})
  }

  const floor = armory ? armory.builtins.filter((b) => b.badges.includes('floor')) : []
  const equipped = {
    allBuiltins: false,
    builtins: obj.tools,
    servers: [...new Set([...(obj.mcpServers ?? []), ...obj.tools.map((t) => /^mcp__(.+?)__/.exec(t)?.[1]).filter((x): x is string => !!x)])],
    packs: obj.packs ?? [],
  }
  const equip = (kind: ArmoryKind, id: string) => {
    if (kind === 'builtin') { if (!obj.tools.includes(id)) set({ loadout: 'equipped', tools: [...obj.tools, id] }) }
    else if (kind === 'mcp') {
      const s = armory?.mcpServers.find((x) => x.id === id)
      set({ loadout: 'equipped', tools: [...new Set([...obj.tools, ...(s?.tools.map((t) => t.id) ?? [])])], mcpServers: [...new Set([...(obj.mcpServers ?? []), id])] })
    } else set({ loadout: 'equipped', packs: [...new Set([...(obj.packs ?? []), id])] })
  }
  const unequip = (kind: ArmoryKind, id: string) => {
    if (kind === 'builtin') set({ tools: obj.tools.filter((t) => t !== id) })
    else if (kind === 'mcp') set({ tools: obj.tools.filter((t) => !t.startsWith(MCP(id))), mcpServers: (obj.mcpServers ?? []).filter((x) => x !== id) })
    else set({ packs: (obj.packs ?? []).filter((x) => x !== id) })
  }
  const startFrom = (name: string) => {
    const p = personas.find((x) => x.name === name)
    if (!p) return
    const tools = p.tools.filter((t) => t !== '*')
    set({ loadout: 'equipped', tools, mcpServers: [...new Set(tools.map((t) => /^mcp__(.+?)__/.exec(t)?.[1]).filter((x): x is string => !!x))] })
  }

  const card = 'rounded-[14px] border border-line bg-bg-hi p-4 flex flex-col gap-2 min-w-0'
  const btn = 'h-9 px-4 rounded-[10px] border border-line bg-bg text-[13px] font-semibold text-fg hover:border-rule self-start'
  const primary = 'h-9 px-4 rounded-[10px] border border-transparent bg-accent text-bg text-[13px] font-semibold hover:opacity-90 self-start'
  const others = personas.filter((p) => p.name !== obj.name)
  return (
    <section data-testid="agent-undecided-choice" className="px-[18px] py-4 rounded-[14px] border border-dashed border-honey bg-honey/10 flex flex-col gap-3">
      <h2 className="font-serif text-[22px] text-fg">Choose a loadout <span className="text-[13px] italic text-fg-dim">before the adventure starts</span></h2>
      <p className="text-[13px] text-fg-dim">
        <span className="font-mono">{obj.name}</span> has no tools decision on record, so today it runs with{' '}
        <strong className="text-fg">every tool on this machine</strong>. Pick one; you can change it any time.
      </p>
      <div className={`${card} w-full`} data-choice="bare">
        <div className="font-semibold text-fg">Bare <span className="font-serif italic font-normal text-fg-dim text-[12px]">empty-handed</span></div>
        <p className="text-[12.5px] text-fg-dim">Nothing equipped — only the floor no agent can drop.</p>
        {floor.length > 0 && (
          <div data-testid="agent-choice-floor" className="flex flex-wrap gap-1.5">
            {floor.map((f) => <span key={f.id} className="px-2 py-0.5 rounded-md text-[12px] font-mono border border-line bg-bg text-fg-dim">{f.label}</span>)}
          </div>
        )}
        <button type="button" data-testid="agent-choose-bare" onClick={() => set({ loadout: 'bare', tools: [] })} className={btn}>Go bare</button>
      </div>
      <div className={`${card} w-full border-accent relative`} data-choice="pick">
        <span className="absolute -top-2 right-4 px-2 rounded bg-accent text-bg text-[10px] font-semibold tracking-wide">RECOMMENDED</span>
        <div className="font-semibold text-fg">Pick gear <span className="font-serif italic font-normal text-fg-dim text-[12px]">outfit the character</span></div>
        <p className="text-[12.5px] text-fg-dim">Equip exactly what {obj.name} needs from the Armory.</p>
        <label className="flex items-center gap-2 text-[12.5px] text-fg-dim">
          Start from
          <select
            data-testid="agent-start-from"
            onFocus={loadPersonas}
            onMouseEnter={loadPersonas}
            aria-label={`Start from another agent`}
            value=""
            onChange={(e) => { if (e.target.value) startFrom(e.target.value) }}
            className="h-8 rounded-md border border-line bg-bg px-2 font-mono text-fg max-w-[16rem]"
          >
            <option value="">another agent's gear…</option>
            {others.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        <button type="button" data-testid="agent-choose-pick" onClick={() => setPicking(true)} className={primary}>Open the Armory</button>
      </div>
      <div className={`${card} w-full`} data-choice="unbound">
        <div className="font-semibold text-fg">Unbound <span className="font-serif italic font-normal text-fg-dim text-[12px]">every relic in the vault</span></div>
        <p className="text-[12.5px] text-fg-dim">Every tool on this machine — MCP servers too, including ones added later. Today's behaviour, chosen on purpose.</p>
        <button type="button" data-testid="agent-choose-unbound" onClick={() => set({ loadout: 'unbound', tools: ['*'] })} className={btn}>Go unbound</button>
      </div>
      <div data-testid="agent-runs-today" className={`${card} w-full`}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint">Where {obj.name} runs today</div>
        <ul className="flex flex-col gap-1 text-[13px] text-fg">
          <li>Epic chat</li><li>Scheduler jobs</li><li>Tasks</li>
        </ul>
        <div className="text-[11.5px] text-fg-faint italic">Your choice applies to their next sessions; running ones keep every tool until they end.</div>
      </div>
      <p className="text-[12px] text-fg-dim">
        <button type="button" data-testid="agent-choose-later" onClick={onDismiss} className="underline text-fg">Not now</button>
        {' '}— {obj.name} keeps running with every tool and stays flagged in the roster.
      </p>
      {picking && (
        <ArmoryDrawer
          armory={armory}
          equipped={equipped}
          onEquip={equip}
          onUnequip={unequip}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  )
}
